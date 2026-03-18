import { AiChat } from '@/components/ai/AiChat.tsx';
import { AiRecommendations } from '@/components/ai/AiRecommendations.tsx';
import { useAiSettings } from '@/hooks/useAi.ts';
import { Box, Paper, Tab, Tabs, Typography } from '@mui/material';
import { useState } from 'react';

export default function AiPage() {
  const [tab, setTab] = useState(0);
  const { data: settings } = useAiSettings();

  if (settings && !settings.enabled) {
    return (
      <Box>
        <Typography variant="h3" mb={2}>
          AI Assistant
        </Typography>
        <Paper sx={{ p: 3 }}>
          <Typography>
            AI features are disabled. Enable them in Settings &gt; AI.
          </Typography>
        </Paper>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h3" mb={2}>
        AI Assistant
      </Typography>
      <Paper sx={{ p: [1, 2] }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="Chat" />
          <Tab label="Recommendations" />
        </Tabs>
        <Box sx={{ py: 2 }}>
          {tab === 0 && <AiChat />}
          {tab === 1 && <AiRecommendations />}
        </Box>
      </Paper>
    </Box>
  );
}
