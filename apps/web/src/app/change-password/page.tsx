import { ChangePasswordPage } from '@/features/auth/change-password';

export const metadata = { title: 'Change password' };

export default function Page() {
  return <ChangePasswordPage kind="tenant" />;
}
