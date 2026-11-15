import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Notice, Panel } from '../components/ui';

export interface ToolChunkBoundaryProps {
  /** Human name of the instrument whose chunk failed. */
  label: string;
  /** Called on Retry so the parent can create a fresh lazy loader. */
  onRetry: () => void;
  children: ReactNode;
}

interface ToolChunkBoundaryState {
  failed: boolean;
}

/**
 * Error boundary around a lazy instrument chunk. A failed dynamic import (bad
 * network, redeploy in another tab) must not blank the whole workspace: the
 * boundary keeps the tab usable and offers a Retry that creates a fresh lazy
 * component instead of re-surfacing the cached rejected promise.
 */
export class ToolChunkBoundary extends Component<ToolChunkBoundaryProps, ToolChunkBoundaryState> {
  state: ToolChunkBoundaryState = { failed: false };

  static getDerivedStateFromError(): ToolChunkBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      // Dev-only diagnostics; never shipped to production consoles.
      console.warn(`[Geodesia] ${this.props.label} chunk failed`, error, info.componentStack);
    }
  }

  private handleRetry = (): void => {
    this.props.onRetry();
    this.setState({ failed: false });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Panel title={this.props.label} meta="chunk failed" tight>
        <Notice
          tone="err"
          title="This instrument did not load"
          action={
            <button type="button" className="btn btn--sm" onClick={this.handleRetry}>
              Retry loading
            </button>
          }
        >
          The {this.props.label.toLowerCase()} code could not be downloaded (network or a deployment
          changed mid-session). Your other instruments and any saved work are unaffected.
        </Notice>
      </Panel>
    );
  }
}
