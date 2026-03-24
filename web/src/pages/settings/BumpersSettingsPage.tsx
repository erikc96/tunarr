import {
  useBumperPacks,
  useCreateBumperPack,
  useDeleteBumperPack,
  useRescanBumperPack,
  type BumperPack,
} from '@/hooks/useBumpers.ts';
import {
  Add,
  Delete,
  Refresh,
  VideoFile,
} from '@mui/icons-material';
import {
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function BumperPackCard({ pack }: { pack: BumperPack }) {
  const rescan = useRescanBumperPack();
  const del = useDeleteBumperPack();
  const { enqueueSnackbar } = useSnackbar();

  const handleRescan = () => {
    rescan.mutate(pack.id, {
      onSuccess: (updated) =>
        enqueueSnackbar(`Rescanned: ${updated.files.length} files`, {
          variant: 'success',
        }),
      onError: (e) => enqueueSnackbar(e.message, { variant: 'error' }),
    });
  };

  const handleDelete = () => {
    del.mutate(pack.id, {
      onSuccess: () =>
        enqueueSnackbar(`Deleted pack "${pack.name}"`, { variant: 'success' }),
      onError: (e) => enqueueSnackbar(e.message, { variant: 'error' }),
    });
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle1" fontWeight="bold">
          {pack.name}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {pack.directory}
        </Typography>
        <Stack direction="row" spacing={1} mt={1} flexWrap="wrap">
          <Typography variant="body2">
            {pack.files.length} file{pack.files.length !== 1 ? 's' : ''}
          </Typography>
          {pack.files.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              ·{' '}
              {formatDuration(
                pack.files.reduce((sum, f) => sum + f.durationMs, 0),
              )}{' '}
              total
            </Typography>
          )}
        </Stack>
      </CardContent>
      <CardActions>
        <Button
          size="small"
          startIcon={<Refresh />}
          onClick={handleRescan}
          disabled={rescan.isPending}
        >
          {rescan.isPending ? <CircularProgress size={16} /> : 'Rescan'}
        </Button>
        <Button
          size="small"
          color="error"
          startIcon={<Delete />}
          onClick={handleDelete}
          disabled={del.isPending}
        >
          Delete
        </Button>
      </CardActions>
    </Card>
  );
}

function AddPackDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  const create = useCreateBumperPack();
  const { enqueueSnackbar } = useSnackbar();

  const handleSubmit = () => {
    if (!name.trim() || !directory.trim()) return;
    create.mutate(
      { name: name.trim(), directory: directory.trim() },
      {
        onSuccess: (pack) => {
          enqueueSnackbar(
            `Pack "${pack.name}" created with ${pack.files.length} files`,
            { variant: 'success' },
          );
          setName('');
          setDirectory('');
          onClose();
        },
        onError: (e) => enqueueSnackbar(e.message, { variant: 'error' }),
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add Bumper Pack</DialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <TextField
            label="Pack Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Adult Swim Bumpers"
            fullWidth
          />
          <TextField
            label="Directory Path"
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder="/mnt/media/bumpers/adult-swim"
            helperText="Absolute path to a directory of video files on the server"
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={create.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!name.trim() || !directory.trim() || create.isPending}
        >
          {create.isPending ? <CircularProgress size={20} /> : 'Scan & Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function BumpersSettingsPage() {
  const { data: packs, isLoading } = useBumperPacks();
  const [addOpen, setAddOpen] = useState(false);

  if (isLoading) return <CircularProgress />;

  return (
    <Box>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        mb={2}
      >
        <Typography variant="h5">
          <VideoFile sx={{ mr: 1, verticalAlign: 'middle' }} />
          Bumper Packs
        </Typography>
        <Button
          variant="contained"
          startIcon={<Add />}
          onClick={() => setAddOpen(true)}
        >
          Add Pack
        </Button>
      </Stack>

      <Typography variant="body2" color="text.secondary" mb={2}>
        Bumper packs are directories of short video clips that can be inserted
        between programs on a channel using the{' '}
        <strong>Insert Bumpers</strong> scheduling operation.
      </Typography>

      {(!packs || packs.length === 0) && (
        <Typography color="text.secondary">
          No bumper packs added yet. Click <strong>Add Pack</strong> to scan a
          directory.
        </Typography>
      )}

      <Stack spacing={2}>
        {packs?.map((pack) => <BumperPackCard key={pack.id} pack={pack} />)}
      </Stack>

      <AddPackDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </Box>
  );
}
