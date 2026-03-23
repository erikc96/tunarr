import {
  useAiSettings,
  useUpdateAiSettings,
  useTestAiConnection,
} from '@/hooks/useAi.ts';
import {
  Box,
  Button,
  CircularProgress,
  Divider,
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
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [autoScanIntervalMinutes, setAutoScanIntervalMinutes] = useState(30);

  useEffect(() => {
    if (settings) {
      setModel(settings.model);
      setEnabled(settings.enabled);
      setAutoScanEnabled(settings.autoScanEnabled);
      setAutoScanIntervalMinutes(settings.autoScanIntervalMinutes);
    }
  }, [settings]);

  if (isLoading) return <CircularProgress />;

  const handleSave = () => {
    const body: Record<string, unknown> = {
      model,
      enabled,
      autoScanEnabled,
      autoScanIntervalMinutes,
    };
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
        <Divider />
        <Typography variant="subtitle2" color="text.secondary">
          Auto-scheduling
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={autoScanEnabled}
              onChange={(_, v) => setAutoScanEnabled(v)}
            />
          }
          label="Enable automatic channel replenishment"
          disabled={!enabled}
        />
        <TextField
          label="Auto-scan interval (minutes)"
          type="number"
          value={autoScanIntervalMinutes}
          onChange={(e) =>
            setAutoScanIntervalMinutes(Math.max(5, parseInt(e.target.value) || 30))
          }
          inputProps={{ min: 5, max: 1440 }}
          helperText="How often to check if channels need replenishment (5–1440 min)"
          fullWidth
          disabled={!enabled || !autoScanEnabled}
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
