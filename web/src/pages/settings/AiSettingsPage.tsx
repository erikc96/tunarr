import {
  useAiSettings,
  useUpdateAiSettings,
  useTestAiConnection,
} from '@/hooks/useAi.ts';
import {
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { useEffect, useState } from 'react';

export default function AiSettingsPage() {
  const { data: settings, isLoading } = useAiSettings();
  const updateSettings = useUpdateAiSettings();
  const testConnection = useTestAiConnection();
  const { enqueueSnackbar } = useSnackbar();

  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (settings) {
      setModel(settings.model);
      setEnabled(settings.enabled);
    }
  }, [settings]);

  if (isLoading) return <CircularProgress />;

  const handleSave = () => {
    const body: Record<string, unknown> = { model, enabled };
    if (apiKey.length > 0) body.apiKey = apiKey;
    updateSettings.mutate(body as Parameters<typeof updateSettings.mutate>[0], {
      onSuccess: () => {
        setApiKey('');
        enqueueSnackbar('AI settings saved', { variant: 'success' });
      },
      onError: (err) => {
        enqueueSnackbar(err.message, { variant: 'error' });
      },
    });
  };

  const handleTest = () => {
    testConnection.mutate(undefined, {
      onSuccess: (data) => {
        enqueueSnackbar(
          data.ok ? 'Connection successful' : `Failed: ${data.error}`,
          { variant: data.ok ? 'success' : 'error' },
        );
      },
      onError: (err) => {
        enqueueSnackbar(err.message, { variant: 'error' });
      },
    });
  };

  return (
    <Box>
      <Typography variant="h5" mb={2}>
        AI Settings
      </Typography>
      <Stack spacing={3} maxWidth={500}>
        <TextField
          label="Anthropic API Key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={settings?.hasApiKey ? '••••••••' : 'sk-ant-...'}
          helperText={settings?.hasApiKey ? 'Key is set. Enter a new one to replace it.' : ''}
          fullWidth
        />
        <TextField
          label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          fullWidth
        />
        <FormControlLabel
          control={
            <Switch checked={enabled} onChange={(_, v) => setEnabled(v)} />
          }
          label="Enable AI features"
        />
        <Stack direction="row" spacing={2}>
          <Button variant="contained" onClick={handleSave} disabled={updateSettings.isPending}>
            Save
          </Button>
          <Button
            variant="outlined"
            onClick={handleTest}
            disabled={testConnection.isPending}
          >
            {testConnection.isPending ? <CircularProgress size={20} /> : 'Test Connection'}
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}
