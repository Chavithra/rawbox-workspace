import { Outlet } from "react-router";

import "./App.css";
import AppSidebar from "./components/AppSidebar";
import { SidebarProvider, SidebarTrigger } from "./components/ui/sidebar";
import { Toaster } from "sonner";

function App() {
  return (
    <SidebarProvider>
      <header>
        <AppSidebar />
      </header>

      <main className="w-full bg-gray-50 text-lg text-gray-700">
        <Toaster />
        <div className="bg-background sticky top-0 z-50 flex w-full items-center border-b">
          <SidebarTrigger />
          Rawbox
        </div>

        <Outlet />
      </main>
    </SidebarProvider>
  );
}

export default App;
