import { useContext } from 'react'
import { ssoClient } from '@better-auth/sso/client'
import { stripeClient } from '@better-auth/stripe/client'
import {
  customSessionClient,
  emailOTPClient,
  genericOAuthClient,
  organizationClient,
} from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import type { auth } from '@/lib/auth'
import { env } from '@/lib/core/config/env'
import { isBillingEnabled } from '@/lib/core/config/feature-flags'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { SessionContext, type SessionHookResult } from '@/app/_shell/providers/session-provider'

function getAuthClientBaseUrl(): string {
  // In the browser, always prefer the current origin. This prevents subtle
  // misconfigurations (e.g. NEXT_PUBLIC_APP_URL still set to :3000 while the dev server
  // runs on :2222) from breaking auth flows via cross-origin/CORS.
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }

  // Server-side (or during build), fall back to the configured public base URL.
  return getBaseUrl()
}

export const client = createAuthClient({
  baseURL: getAuthClientBaseUrl(),
  plugins: [
    emailOTPClient(),
    genericOAuthClient(),
    customSessionClient<typeof auth>(),
    ...(isBillingEnabled
      ? [
          stripeClient({
            subscription: true, // Enable subscription management
          }),
          organizationClient(),
        ]
      : []),
    ...(env.NEXT_PUBLIC_SSO_ENABLED ? [ssoClient()] : []),
  ],
})

export function useSession(): SessionHookResult {
  const ctx = useContext(SessionContext)
  if (!ctx) {
    throw new Error(
      'SessionProvider is not mounted. Wrap your app with <SessionProvider> in app/layout.tsx.'
    )
  }
  return ctx
}

export const useActiveOrganization = isBillingEnabled
  ? client.useActiveOrganization
  : () => ({ data: undefined, isPending: false, error: null })

export const useSubscription = () => {
  return {
    list: client.subscription?.list,
    upgrade: client.subscription?.upgrade,
    cancel: client.subscription?.cancel,
    restore: client.subscription?.restore,
  }
}

export const { signIn, signUp, signOut } = client
