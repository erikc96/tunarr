import {
  useAiRecommendations,
  useApplyChannel,
  useAddPrograms,
  useRefreshChannel,
  type AiRecommendation,
} from '@/hooks/useAi.ts';
import {
  Add,
  AutoAwesome,
  Refresh,
  TipsAndUpdates,
} from '@mui/icons-material';
import {
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';

const typeLabel: Record<AiRecommendation['type'], string> = {
  'new-channel': 'New Channel',
  'schedule-improvement': 'Improve',
  'content-addition': 'Add Content',
  'gap-analysis': 'Gap',
};

const typeColor: Record<AiRecommendation['type'], 'primary' | 'secondary' | 'success' | 'info'> = {
  'new-channel': 'primary',
  'schedule-improvement': 'secondary',
  'content-addition': 'success',
  'gap-analysis': 'info',
};

export function AiRecommendations() {
  const { data, isLoading, refetch, isRefetching } = useAiRecommendations();
  const applyChannel = useApplyChannel();
  const addPrograms = useAddPrograms();
  const refreshChannel = useRefreshChannel();
  const { enqueueSnackbar } = useSnackbar();

  const handleAction = (rec: AiRecommendation) => {
    switch (rec.type) {
      case 'new-channel':
        applyChannel.mutate(rec.actionPrompt, {
          onSuccess: (r) =>
            enqueueSnackbar(`Channel "${r.name}" created`, {
              variant: 'success',
            }),
          onError: (e) => enqueueSnackbar(e.message, { variant: 'error' }),
        });
        break;
      case 'content-addition':
        if (rec.targetChannel != null) {
          addPrograms.mutate(
            { channelId: String(rec.targetChannel), prompt: rec.actionPrompt },
            {
              onSuccess: (r) =>
                enqueueSnackbar(
                  `Added ${r.newProgramUuids.length} programs`,
                  { variant: 'success' },
                ),
              onError: (e) => enqueueSnackbar(e.message, { variant: 'error' }),
            },
          );
        }
        break;
      case 'schedule-improvement':
        if (rec.targetChannel != null) {
          refreshChannel.mutate(String(rec.targetChannel), {
            onSuccess: (r) =>
              enqueueSnackbar(
                `Added ${r.newProgramUuids.length} new programs`,
                { variant: 'success' },
              ),
            onError: (e) => enqueueSnackbar(e.message, { variant: 'error' }),
          });
        }
        break;
    }
  };

  const isPending =
    applyChannel.isPending ||
    addPrograms.isPending ||
    refreshChannel.isPending;

  if (isLoading) return <CircularProgress />;

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h6">
          <TipsAndUpdates sx={{ mr: 1, verticalAlign: 'middle' }} />
          Recommendations
        </Typography>
        <Button
          startIcon={<Refresh />}
          onClick={() => refetch()}
          disabled={isRefetching}
          size="small"
        >
          {isRefetching ? 'Loading...' : 'Refresh'}
        </Button>
      </Stack>

      {!data?.recommendations?.length && (
        <Typography color="text.secondary">
          No recommendations yet. Click Refresh to analyze your library.
        </Typography>
      )}

      {data?.recommendations?.map((rec, i) => (
        <Card key={i} variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" mb={1}>
              <Chip
                label={typeLabel[rec.type]}
                color={typeColor[rec.type]}
                size="small"
              />
              {rec.targetChannel != null && (
                <Chip
                  label={`Ch #${rec.targetChannel}`}
                  size="small"
                  variant="outlined"
                />
              )}
            </Stack>
            <Typography variant="subtitle1" fontWeight="bold">
              {rec.title}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {rec.description}
            </Typography>
            {rec.items && rec.items.length > 0 && (
              <Box sx={{ mt: 1 }}>
                {rec.items.slice(0, 8).map((item, j) => (
                  <Chip
                    key={j}
                    label={item}
                    size="small"
                    variant="outlined"
                    sx={{ mr: 0.5, mb: 0.5 }}
                  />
                ))}
                {rec.items.length > 8 && (
                  <Chip
                    label={`+${rec.items.length - 8} more`}
                    size="small"
                    sx={{ mr: 0.5, mb: 0.5 }}
                  />
                )}
              </Box>
            )}
          </CardContent>
          <CardActions>
            {rec.type !== 'gap-analysis' && (
              <Button
                size="small"
                startIcon={
                  rec.type === 'new-channel' ? (
                    <AutoAwesome />
                  ) : (
                    <Add />
                  )
                }
                onClick={() => handleAction(rec)}
                disabled={isPending}
              >
                {rec.type === 'new-channel' ? 'Create Channel' : 'Apply'}
              </Button>
            )}
          </CardActions>
        </Card>
      ))}
    </Stack>
  );
}
