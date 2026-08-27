import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Logged without exposing tokens/passwords — only the error message and component stack.
    console.error("Unhandled UI error:", error.message, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-card">
            <div className="icon">⚠️</div>
            <h2>Бір нәрсе дұрыс болмады</h2>
            <p>Бетті жаңартып көріңіз. Мәселе қайталанса, әкімшіге хабарласыңыз.</p>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Бетті жаңарту
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
