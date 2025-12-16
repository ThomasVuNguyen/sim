import { redirect } from 'next/navigation'
import { isAuthDisabled } from '@/lib/core/config/feature-flags'
import ResetPasswordPageClient from '@/app/(auth)/reset-password/reset-password-page-client'

export const dynamic = 'force-dynamic'

export default function ResetPasswordPage() {
  if (isAuthDisabled) {
    redirect('/workspace')
  }

  return <ResetPasswordPageClient />
}
