import "tldraw/tldraw.css";
import { useStore } from "./hooks/useStore";
import { Tldraw } from "tldraw";
import { NameEditor } from "./components/NameEditor";

const HOST_URL = "ws://localhost:1234";

function App() {
  const store = useStore({
    roomId: "sampleRoom",
    hostUrl: HOST_URL,
  });

  return (
    <div className="tldraw__editor">
      <Tldraw
        autoFocus
        store={store}
        components={{
          SharePanel: NameEditor,
        }}
      />
    </div>
  );
}

export default App;
