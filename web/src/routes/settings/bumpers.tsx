import BumpersSettingsPage from '@/pages/settings/BumpersSettingsPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/bumpers')({
  component: BumpersSettingsPage,
});
