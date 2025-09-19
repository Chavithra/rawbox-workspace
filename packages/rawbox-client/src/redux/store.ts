import { configureStore } from "@reduxjs/toolkit";

import { rawboxApi } from "./rawbox-api";

export const store = configureStore({
  reducer: {
    // Add the generated API slice reducer to the store
    [rawboxApi.reducerPath]: rawboxApi.reducer,
  },
  // Adding the api middleware enables caching, invalidation, polling, and other RTK Query features
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(rawboxApi.middleware),
});
