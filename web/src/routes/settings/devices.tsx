import DevicesSettingsPage from '@/pages/settings/DevicesSettingsPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/devices')({
  component: DevicesSettingsPage,
});
