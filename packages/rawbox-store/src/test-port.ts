import { Worker, isMainThread, parentPort, workerData } from "worker_threads";

if (isMainThread) {
  console.log("--- Main Thread (Sender) ---");

  // 1. Create a Worker
  // The worker will execute the same file, but the `else` block will run.
  const worker = new Worker("./dist/test-port.js");

  const dataStr = "Hello there!";
  const dataBuffer = Buffer.from(dataStr, "utf8");

  // 2. Listen for messages from the worker
  worker.on("message", (message) => {
    console.log(`\nMain Thread: Received from worker: ${message}`);
    // Terminate the worker after the demonstration
    worker.terminate();
  });

  worker.on("error", (err) => console.error("Worker error:", err));
  worker.on("exit", (code) => {
    if (code !== 0) console.error(`Worker stopped with exit code ${code}`);
  });

  // 3. Create a Uint8Array with some data
  // const originalUint8Array = new Uint8Array([
  //   10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
  // ]);
  const originalUint8Array = new Uint8Array(
    dataBuffer.buffer,
    dataBuffer.byteOffset,
    dataBuffer.byteLength
  );

  console.log("Original Uint8Array State (before sending):");
  console.log("  Length:", originalUint8Array.length);
  console.log("  Value at index 0:", originalUint8Array[0]);
  console.log("  Underlying ArrayBuffer:", originalUint8Array.buffer); // Should show a valid ArrayBuffer object
  console.log(
    "  Is originalUint8Array.buffer detached?",
    originalUint8Array.buffer.byteLength === 0
  ); // Should be false

  // 4. Send the Uint8Array to the worker, transferring its underlying ArrayBuffer
  console.log("\nMain Thread: Sending Uint8Array to worker...");
  // parentPort.postMessage is used by the worker to send to main.
  // In the main thread, we use the `worker` object's `postMessage` method.
  // The `transferList` MUST contain the ArrayBuffer that backs the Uint8Array.
  worker.postMessage({ type: "SEND_DATA", data: originalUint8Array }, [
    originalUint8Array.buffer,
  ]);

  // 5. Immediately after sending, try to access the original Uint8Array
  // This part demonstrates the detachment.
  console.log(
    "\nMain Thread: State of Original Uint8Array (after sending - should be detached):"
  );
  try {
    // Attempting to access properties like length or elements on a detached TypedArray
    // will typically result in a TypeError in Node.js.
    console.log("  Attempting to read originalUint8Array.length...");
    console.log("  Length:", originalUint8Array.length); // Expect this to throw or show 0
    console.log("  Attempting to read originalUint8Array[0]...");
    console.log("  Value at index 0:", originalUint8Array[0]); // Expect this to throw or show undefined
    console.log("  Attempting to read originalUint8Array.buffer...");
    console.log("  Underlying ArrayBuffer:", originalUint8Array.buffer); // Expect this to be null or a detached ArrayBuffer

    // A more robust check for detachment:
    if (
      originalUint8Array.buffer === null ||
      originalUint8Array.buffer.byteLength === 0
    ) {
      console.log(
        "  Proof: The ArrayBuffer has been detached from this Uint8Array!"
      );
    } else {
      console.log(
        "  Warning: ArrayBuffer might not be fully detached, or environment behaves differently."
      );
    }
  } catch (e: any) {
    console.error(
      `  Proof: Caught expected error accessing detached Uint8Array: ${e.message}`
    );
    console.error(
      "  This confirms the Uint8Array is no longer usable in the sender thread."
    );
  }
} else {
  // This code runs in the Worker Thread
  console.log("\n--- Worker Thread (Receiver) ---");

  // `parentPort` is the MessagePort connected to the main thread
  if (parentPort) {
    parentPort.on("message", (message) => {
      const { type: messageType, data: receivedUint8Array } = message;

      console.log("Worker Thread: Received Uint8Array.");

      console.log("Received Uint8Array State (in worker):");
      console.log("  Length:", receivedUint8Array.length);
      console.log("  Value at index 0:", receivedUint8Array[0]);
      console.log("  Underlying ArrayBuffer:", receivedUint8Array.buffer); // Should show a valid ArrayBuffer
      console.log(
        "  Is receivedUint8Array.buffer detached?",
        receivedUint8Array.buffer.byteLength === 0
      ); // Should be false

      // Modify the received data to show it's now owned by the worker
      receivedUint8Array[0] = 99;
      console.log("  Modified value at index 0 to 99 in worker.");

      // Send a confirmation message back to the main thread
      parentPort!.postMessage("Uint8Array received and modified in worker.");
    });

    // Let the main thread know the worker is ready to receive
    parentPort.postMessage("Worker is ready to receive.");
  } else {
    console.error(
      "Worker Thread: parentPort is null. This should not happen in a worker_threads setup."
    );
  }
}
