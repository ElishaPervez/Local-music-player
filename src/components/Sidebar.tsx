import {
  Home,
  Search,
  ListMusic,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useUIStore, type View } from "../stores/uiStore";
import "./Sidebar.css";

const NAV: { id: View; label: string; icon: typeof Search }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "finder", label: "Finder", icon: Search },
  { id: "playlists", label: "Playlists", icon: ListMusic },
];

export default function Sidebar() {
  const view = useUIStore((s) => s.view);
  const setView = useUIStore((s) => s.setView);
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      {/* Fixed-position toggle: anchored to the sidebar's (stationary) left edge,
          so its on-screen coordinates never move when the width animates. */}
      <button
        className="sidebar-toggle"
        onClick={toggleSidebar}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </button>

      <div className="sidebar-brand">
        <span className="brand-mark">🎵</span>
        <span className="brand-label">Local Music</span>
      </div>

      <nav className="sidebar-nav">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${view === id ? "active" : ""}`}
            onClick={() => setView(id)}
            title={label}
          >
            <Icon size={19} className="nav-icon" />
            <span className="nav-label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button
          className={`nav-item ${view === "settings" ? "active" : ""}`}
          onClick={() => setView("settings")}
          title="Settings"
        >
          <Settings size={19} className="nav-icon" />
          <span className="nav-label">Settings</span>
        </button>
      </div>
    </aside>
  );
}
