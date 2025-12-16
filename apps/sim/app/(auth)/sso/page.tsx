import { redirect } from 'next/navigation'
import { getEnv, isTruthy } from '@/lib/core/config/env'
import { isAuthDisabled } from '@/lib/core/config/feature-flags'
import SSOForm from '@/app/(auth)/sso/sso-form'

export const dynamic = 'force-dynamic'

export default async function SSOPage() {
  if (isAuthDisabled) {
    redirect('/workspace')
  }

  if (!isTruthy(getEnv('NEXT_PUBLIC_SSO_ENABLED'))) {
    redirect('/login')
  }

  return <SSOForm />
}
