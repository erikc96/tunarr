import { useBumperPacks } from '@/hooks/useBumpers.ts';
import { useInsertBumpers } from '@/hooks/programming_controls/useInsertBumpers.ts';
import { Route } from '@/routes/channels_/$channelId/programming/index.tsx';
import { VideoFile } from '@mui/icons-material';
import {
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function InsertBumpersModal({ open, onClose }: Props) {
  const { channelId } = Route.useParams();
  const { data: packs, isLoading } = useBumperPacks();
  const insertBumpers = useInsertBumpers(channelId);
  const { enqueueSnackbar } = useSnackbar();

  const [packId, setPackId] = useState('');
  const [betweenEnabled, setBetweenEnabled] = useState(true);
  const [betweenCount, setBetweenCount] = useState(1);
  const [withinEnabled, setWithinEnabled] = useState(false);
  const [withinInterruptCount, setWithinInterruptCount] = useState(2);

  const handleSave = () => {
    if (!packId) return;
    if (!betweenEnabled && !withinEnabled) return;
    insertBumpers.mutate(
      {
        packId,
        betweenCount: betweenEnabled ? betweenCount : undefined,
        withinInterruptCount: withinEnabled ? withinInterruptCount : undefined,
      },
      {
        onSuccess: () => {
          enqueueSnackbar('Bumpers enabled for this channel', {
            variant: 'success',
          });
          onClose();
        },
        onError: (e) => enqueueSnackbar(e.message, { variant: 'error' }),
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Insert Bumpers</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Insert short video clips from a bumper pack. Enable one or both
          options below.
        </DialogContentText>
        {isLoading && <CircularProgress size={24} />}
        {!isLoading && (!packs || packs.length === 0) && (
          <Typography color="text.secondary">
            No bumper packs found. Add one in{' '}
            <strong>Settings → Bumpers</strong> first.
          </Typography>
        )}
        {packs && packs.length > 0 && (
          <Stack spacing={2}>
            <FormControl fullWidth>
              <InputLabel>Bumper Pack</InputLabel>
              <Select
                value={packId}
                label="Bumper Pack"
                onChange={(e) => setPackId(e.target.value)}
              >
                {packs.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name} ({p.files.length} clips)
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Divider />

            {/* Between programs */}
            <Stack spacing={1}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={betweenEnabled}
                    onChange={(e) => setBetweenEnabled(e.target.checked)}
                  />
                }
                label={<Typography fontWeight="medium">Between programs</Typography>}
              />
              {betweenEnabled && (
                <FormControl fullWidth size="small" sx={{ pl: 4 }}>
                  <InputLabel>Bumpers per gap</InputLabel>
                  <Select
                    value={betweenCount}
                    label="Bumpers per gap"
                    onChange={(e) => setBetweenCount(Number(e.target.value))}
                  >
                    {[1, 2, 3].map((n) => (
                      <MenuItem key={n} value={n}>
                        {n}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
            </Stack>

            <Divider />

            {/* Within each program */}
            <Stack spacing={1}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={withinEnabled}
                    onChange={(e) => setWithinEnabled(e.target.checked)}
                  />
                }
                label={<Typography fontWeight="medium">Within each program</Typography>}
              />
              {withinEnabled && (
                <FormControl fullWidth size="small" sx={{ pl: 4 }}>
                  <InputLabel>Interruptions per program</InputLabel>
                  <Select
                    value={withinInterruptCount}
                    label="Interruptions per program"
                    onChange={(e) =>
                      setWithinInterruptCount(Number(e.target.value))
                    }
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <MenuItem key={n} value={n}>
                        {n}×
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
            </Stack>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={
            insertBumpers.isPending ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <VideoFile />
            )
          }
          onClick={handleSave}
          disabled={
            !packId ||
            (!betweenEnabled && !withinEnabled) ||
            insertBumpers.isPending
          }
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
