import { VoicePanel } from "./voice/VoicePanel.tsx";

// Phase 4: the app's face is now the voice surface - push-to-talk, transcript
// review, and June's reply, all driving the same agent core the text harness does.
export function App() {
  return (
    <div className="app">
      <h1>June</h1>
      <VoicePanel />
    </div>
  );
}
