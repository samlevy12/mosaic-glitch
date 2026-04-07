import React, { ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: (error: Error, retry: () => void) => ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  retry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        this.props.fallback?.(this.state.error, this.retry) ?? (
          <div className="max-w-3xl mx-auto p-6 space-y-4">
            <div className="border border-destructive/30 bg-destructive/5 p-4 rounded space-y-3">
              <h2 className="text-sm font-semibold text-destructive">Something went wrong</h2>
              <p className="text-xs text-muted-foreground">{this.state.error.message}</p>
              <button
                onClick={this.retry}
                className="text-xs px-3 py-1.5 border border-destructive text-destructive hover:bg-destructive hover:text-white transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        )
      )
    }

    return this.props.children
  }
}
