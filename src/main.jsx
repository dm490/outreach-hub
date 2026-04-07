import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider, SignedIn, SignedOut, SignIn } from '@clerk/clerk-react'
import App from './App.jsx'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || 'pk_test_a2luZC1ncmFja2xlLTM3LmNsZXJrLmFjY291bnRzLmRldiQ'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ClerkProvider publishableKey={CLERK_KEY}>
      <SignedIn>
        <App />
      </SignedIn>
      <SignedOut>
        <div style={{
          minHeight: '100vh',
          background: '#0a0e1a',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          padding: '20px'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 32
          }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
              fontWeight: 700,
              color: 'white'
            }}>DJ</div>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: '#f1f5f9' }}>David Joseph &amp; Company</h1>
              <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>Recruiter Portal</div>
            </div>
          </div>
          <SignIn />
        </div>
      </SignedOut>
    </ClerkProvider>
  </StrictMode>
)
