import { type NextRequest, NextResponse } from 'next/server'
import { createAnonymousSession, ensureAnonymousUserExists } from '@/lib/auth/anonymous'
import { isAuthDisabled } from '@/lib/core/config/feature-flags'

export const dynamic = 'force-dynamic'

async function getBetterAuthHandlers() {
  const [{ toNextJsHandler }, { auth }] = await Promise.all([
    import('better-auth/next-js'),
    import('@/lib/auth'),
  ])
  return toNextJsHandler(auth.handler)
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const path = url.pathname.replace('/api/auth/', '')

  if (isAuthDisabled) {
    if (path === 'get-session') {
      await ensureAnonymousUserExists()
      return NextResponse.json(createAnonymousSession())
    }

    // Auth is intentionally disabled in single-user mode.
    return NextResponse.json({ error: 'Auth disabled' }, { status: 404 })
  }

  const { GET } = await getBetterAuthHandlers()
  return GET(request)
}

export async function POST(request: NextRequest) {
  if (isAuthDisabled) {
    return NextResponse.json({ error: 'Auth disabled' }, { status: 404 })
  }

  const { POST } = await getBetterAuthHandlers()
  return POST(request)
}
