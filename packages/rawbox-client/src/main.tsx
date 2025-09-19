import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { StrictMode } from "react";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

import "./index.css";
import { store } from "./redux/store.ts";
import App from "./App.tsx";
import ContractsRegistryListPage from "./pages/ContractsRegistryListPage";
import HomePage from "./pages/HomePage";
import NotFoundPage from "./pages/NotFoundPage";
import StepListEditPage from "./pages/StepListEditPage";
import WorkflowCreatePage from "./pages/WorkflowCreatePage";
import WorkflowEditPage from "./pages/WorkflowEditPage";
import WorkflowListPage from "./pages/WorkflowListPage";
import WorkspaceCreatePage from "./pages/WorkspaceCreatePage";
import WorkspaceEditPage from "./pages/WorkspaceEditPage";
import WorkspaceListPage from "./pages/WorkspaceListPage";
import ConstantListEditPage from "./pages/ConstantListEditPage";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      {
        path: "*",
        element: <NotFoundPage />,
      },
      {
        path: "/ContractsRegistryListPage",
        element: <ContractsRegistryListPage />,
      },
      {
        path: "/ConstantListEditPage/:id",
        element: <ConstantListEditPage />,
      },
      {
        path: "/StepListEditPage/:id",
        element: <StepListEditPage />,
      },
      {
        path: "/WorkflowCreatePage/",
        element: <WorkflowCreatePage />,
      },
      {
        path: "/WorkflowEditPage/:id",
        element: <WorkflowEditPage />,
      },
      {
        path: "/WorkflowListPage/",
        element: <WorkflowListPage />,
      },
      {
        path: "/WorkspaceCreatePage/",
        element: <WorkspaceCreatePage />,
      },
      {
        path: "/WorkspaceEditPage/:id",
        element: <WorkspaceEditPage />,
      },
      {
        path: "/WorkspaceListPage",
        element: <WorkspaceListPage />,
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  </StrictMode>
);
