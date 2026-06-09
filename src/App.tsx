import AppShell from "./components/AppShell";
import SetupGate from "./components/SetupGate";

export default function App() {
  return (
    <SetupGate>
      <AppShell />
    </SetupGate>
  );
}
