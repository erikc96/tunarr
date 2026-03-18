import AiSettingsPage from '@/pages/settings/AiSettingsPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/ai')({
  component: AiSettingsPage,
});
