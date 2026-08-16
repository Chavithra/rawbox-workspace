/**
 * OpenTelemetry SDK wiring — the CLI half of the bridge
 * (rawbox-runner README, "OpenTelemetry").
 *
 * The runner instruments with `@opentelemetry/api` only and is a no-op until
 * *something* registers a provider. This module is that something, and it lives
 * here rather than in `@rawbox/runner` for one reason: choosing a backend is an
 * application decision, and an embedder that already runs its own SDK must not
 * have a second one shoved into its process.
 *
 * Two rules shape everything below:
 *
 * 1. **Nothing is imported until activation.** Every SDK package is behind a
 *    dynamic `import()` inside {@link startOtelSdk}. A run without `--otel` and
 *    without the standard endpoint env vars never loads `@opentelemetry/sdk-node`
 *    or an exporter — it does not pay the resolution, the parse, or the start-up.
 *    {@link isOtelActive} exists precisely so that decision can be made *before*
 *    any of that, from a pure function of a flag and an environment.
 * 2. **The environment is the configuration.** No rawbox-specific endpoint,
 *    header or protocol knobs are invented: the OTLP exporters read the standard
 *    `OTEL_EXPORTER_OTLP_*` variables themselves, so this composes with whatever
 *    collector, Jaeger, Tempo or vendor endpoint the user already has. The only
 *    rawbox-shaped decision made here is a default `service.name`, and even that
 *    yields to `OTEL_SERVICE_NAME`.
 *
 * One packaging note. This package lists `@opentelemetry/api` as a direct
 * dependency even though no line below imports it, because the API's globals are
 * *per module instance*: two copies of `@opentelemetry/api` in one install mean
 * the SDK registers providers into one copy while `@rawbox/runner`'s sink reads
 * the other, and the bridge silently exports nothing. Declaring the same range
 * the runner declares keeps npm hoisting exactly one copy.
 */

import { getErrorMessage } from '../utils/error.js';

/**
 * The `service.name` reported when the user has not set `OTEL_SERVICE_NAME`.
 *
 * A constant rather than the workflow's name: `service.name` identifies the
 * *process* producing telemetry, and `rawbox.workflow.name` already identifies
 * the workflow on every span. One service with many workflows is the shape a
 * backend's service list wants; one service per workflow is how you get a
 * service list nobody can read.
 */
export const DEFAULT_SERVICE_NAME = 'rawbox-cli';

/**
 * Longest {@link OtelSession.shutdown} waits for the exporters to drain.
 *
 * Shutdown flushes the batch processors, which means a network round trip to a
 * collector that may not be there — the OTLP exporter's own default timeout is
 * 10 s, and three signals can serialise. A run that already produced its answer
 * must not hang the terminal on telemetry, so the wait is bounded and a
 * timeout is reported rather than awaited forever.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * The env vars whose mere presence activates the bridge without `--otel`
 * (rawbox-runner README, "Turning it on").
 *
 * Deliberately just the two *endpoint* variables. `OTEL_EXPORTER_OTLP_HEADERS`
 * or `OTEL_SERVICE_NAME` alone say nothing about where telemetry should go, and
 * activating on them would export to `localhost:4318` for a user who only
 * wanted to name their service.
 */
export const OTEL_ACTIVATION_ENV_LIST = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
] as const;

/**
 * Whether this run should export telemetry.
 *
 * The rule, in order:
 *
 * | `--otel` | Endpoint env var | Result |
 * | --- | --- | --- |
 * | `--otel` | anything | active |
 * | `--no-otel` | anything | inactive — an explicit opt-out beats an inherited env |
 * | *(omitted)* | present | active |
 * | *(omitted)* | absent | inactive |
 *
 * A pure function of its two inputs, with no import of anything OTel-shaped, so
 * the CLI can answer "do we need the SDK at all?" before deciding whether to
 * load it — and so the rule is unit-testable without an environment to fake.
 *
 * @param flag - `--otel` / `--no-otel`, or `undefined` when neither was passed.
 * @param env - The environment to read. Defaults to `process.env`.
 */
export function isOtelActive(
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (flag !== undefined) {
    return flag;
  }
  return OTEL_ACTIVATION_ENV_LIST.some((name) => {
    const value = env[name];
    return value !== undefined && value.trim() !== '';
  });
}

/**
 * A started SDK, and the one thing a caller ever does with it.
 *
 * Intentionally not the `NodeSDK` itself: the caller must not be able to
 * reconfigure a running SDK, and typing this structurally keeps
 * `@opentelemetry/sdk-node` out of the CLI's *static* type graph as well as its
 * static import graph.
 */
export interface OtelSession {
  /**
   * Flushes the exporters and tears the providers down. Never rejects: a
   * telemetry backend that is unreachable is a reason to warn, never a reason
   * to change a run's exit code.
   */
  shutdown(): Promise<void>;
}

/**
 * Starts a Node SDK exporting traces, logs and metrics over OTLP/HTTP.
 *
 * Every SDK package is loaded here, dynamically, so that a run that never calls
 * this function never loads them. Once `start()` returns, the API globals the
 * runner's `createOtelSink` talks to are backed by real providers — which is
 * why this must be awaited *before* the sink is constructed.
 *
 * Endpoints, headers, timeouts, compression, sampling and resource attributes
 * all come from the standard `OTEL_*` environment variables that the exporters
 * and the SDK read for themselves; with none of them set, the exporters use the
 * OTLP spec's own `http://localhost:4318` default, which is what a locally
 * running collector, Jaeger or Tempo listens on.
 *
 * Auto-instrumentation is explicitly empty: rawbox exports *its own* spans, and
 * silently patching a user's `http`/`fs` calls is not something a workflow
 * runner should do behind their back.
 *
 * @param reportWarning - Where a start-up or shutdown problem is reported.
 *   Defaults to `console.warn`; the CLI passes its own reporter so the message
 *   lands in the same stream as every other CLI diagnostic.
 */
export async function startOtelSdk(
  reportWarning: (message: string) => void = (message) => console.warn(message),
): Promise<OtelSession> {
  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPLogExporter },
    { OTLPMetricExporter },
    { BatchLogRecordProcessor },
    { PeriodicExportingMetricReader },
    { defaultResource, resourceFromAttributes },
    { ATTR_SERVICE_NAME },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-logs-otlp-http'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/sdk-logs'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]);

  // `OTEL_SERVICE_NAME` wins: the default below is a fallback for the user who
  // turned the flag on and nothing else, not an override of their config.
  const serviceName = process.env.OTEL_SERVICE_NAME?.trim();
  const resource =
    serviceName === undefined || serviceName === ''
      ? defaultResource().merge(
          resourceFromAttributes({ [ATTR_SERVICE_NAME]: DEFAULT_SERVICE_NAME }),
        )
      : defaultResource();

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter(),
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    metricReaders: [
      new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
    ],
    instrumentations: [],
  });

  sdk.start();

  return {
    async shutdown(): Promise<void> {
      try {
        await withTimeout(sdk.shutdown(), SHUTDOWN_TIMEOUT_MS);
      } catch (error) {
        reportWarning(
          `[rawbox] OpenTelemetry shutdown did not complete cleanly, some telemetry may be lost: ${getErrorMessage(error)}`,
        );
      }
    },
  };
}

/**
 * Rejects if `promise` has not settled within `timeoutMs`.
 *
 * The timer is cleared either way, so a bounded wait never keeps the event loop
 * alive past the CLI's own last line — the failure mode this exists to prevent
 * is a hung terminal, and a leaked timer would be the same bug wearing a
 * different hat.
 */
async function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
