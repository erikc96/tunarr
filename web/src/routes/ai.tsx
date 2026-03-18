import AiPage from '@/pages/ai/AiPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ai')({
  component: AiPage,
});
