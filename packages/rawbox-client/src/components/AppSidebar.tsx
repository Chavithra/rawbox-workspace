import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";
import { Home, Bot, DatabaseZap, Book } from "lucide-react";
import { Link } from "react-router";

const items = [
  {
    title: "Home",
    url: "/",
    icon: Home,
  },
  {
    title: "Contracts",
    url: "/ContractsRegistryListPage",
    icon: Book,
  },
  {
    title: "Workflows",
    url: "/WorkflowListPage",
    icon: Bot,
  },
  {
    title: "Workspaces",
    url: "/WorkspaceListPage",
    icon: DatabaseZap,
  },
];

export default function AppSidebar() {
  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <img
            className="mx-auto"
            src="./rawbox-transparent-cropped.png"
            alt="logo"
            height="72px"
            width="100px"
          />
          <SidebarGroupLabel></SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <Link to={item.url}>
                      <item.icon />
                      <span className="text-xl font-semibold">
                        {item.title}
                      </span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
