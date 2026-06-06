import { Component, type ReactNode } from "react"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack)
    this.setState({ errorInfo: info })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      const { error, errorInfo } = this.state
      return (
        <div style={{position:'fixed',top:0,left:0,width:'100vw',height:'100vh',background:'#0a0a0a',color:'#e5e5e5',fontFamily:'monospace',fontSize:'12px',zIndex:99999,overflow:'auto',padding:'20px',display:'flex',flexDirection:'column',gap:'16px'}}>
          <h1 style={{fontSize:'18px',fontWeight:'bold',color:'#ef4444'}}>Something went wrong</h1>

          <div style={{width:'100%',border:'1px solid #ef444433',background:'#ef44440d',padding:'16px',borderRadius:'4px'}}>
            <p style={{fontFamily:'monospace',color:'#ef4444',fontWeight:600}}>{error?.name}: {error?.message}</p>
          </div>

          {error?.stack && (
            <div style={{width:'100%'}}>
              <h2 style={{fontSize:'12px',fontWeight:600,marginBottom:'8px'}}>Stack Trace</h2>
              <pre style={{width:'100%',border:'1px solid #333',background:'#141414',padding:'16px',fontFamily:'monospace',fontSize:'11px',whiteSpace:'pre-wrap',overflowX:'auto',borderRadius:'4px'}}>
                {error.stack}
              </pre>
            </div>
          )}

          {errorInfo?.componentStack && (
            <div style={{width:'100%'}}>
              <h2 style={{fontSize:'12px',fontWeight:600,marginBottom:'8px'}}>Component Stack</h2>
              <pre style={{width:'100%',border:'1px solid #333',background:'#141414',padding:'16px',fontFamily:'monospace',fontSize:'11px',whiteSpace:'pre-wrap',overflowX:'auto',borderRadius:'4px'}}>
                {errorInfo.componentStack}
              </pre>
            </div>
          )}

          <div style={{display:'flex',gap:'12px',paddingTop:'16px'}}>
            <button
              style={{border:'1px solid #333',padding:'8px 16px',fontSize:'12px',background:'#1a1a1a',color:'#e5e5e5',borderRadius:'4px',cursor:'pointer'}}
              onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
            >
              Retry
            </button>
            <button
              style={{border:'1px solid #333',padding:'8px 16px',fontSize:'12px',background:'#1a1a1a',color:'#e5e5e5',borderRadius:'4px',cursor:'pointer'}}
              onClick={() => window.location.reload()}
            >
              Reload Page
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
