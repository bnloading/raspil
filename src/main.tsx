import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./index.css";
import "./styles/admin-pages.css";
import "./styles/customer-pages.css";
import "./styles/worker-pages.css";

// StrictMode's dev-only double-effect-invocation triggers a known Firestore Web SDK bug
// ("INTERNAL ASSERTION FAILED: Unexpected state") when an onSnapshot listener is torn down and
// immediately recreated — see any of src/hooks/use*.ts. Production builds never ran StrictMode's
// extra render/effect pass anyway, so dropping it here has no effect outside local dev.
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
