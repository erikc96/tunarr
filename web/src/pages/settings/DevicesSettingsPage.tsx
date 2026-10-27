import {
  Alert,
  Box,
  Button,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

const Profiles = ['480p', '720p', '1080p'] as const;
type Profile = (typeof Profiles)[number];

type Device = {
  uuid: string;
  slug: string;
  name: string;
  profile: Profile;
  lastSeenAt: number | null;
  lastIp: string | null;
  revokedAt: number | null;
};

const call = async (path: string, init?: RequestInit) => {
  const res = await fetch(`/api/client-devices${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    throw new Error(
      ((await res.json().catch(() => ({}))) as { error?: string }).error ??
        `HTTP ${res.status}`,
    );
  }
  return res.status === 204 ? null : await res.json();
};

// Each device logs in with its own app password; its profile decides the
// picture size Tunarr transcodes for it. The password is shown once.
export default function DevicesSettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['client-devices'],
    queryFn: () => call('') as Promise<Device[]>,
  });
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [profile, setProfile] = useState<Profile>('480p');
  const [created, setCreated] = useState<{ slug: string; password: string }>();

  const refresh = () => qc.invalidateQueries({ queryKey: ['client-devices'] });
  const create = useMutation({
    mutationFn: () =>
      call('', {
        method: 'POST',
        body: JSON.stringify({ name, slug, profile }),
      }) as Promise<{ device: Device; password: string }>,
    onSuccess: (r) => {
      setCreated({ slug: r.device.slug, password: r.password });
      setName('');
      setSlug('');
      void refresh();
    },
  });
  const setProfileFor = useMutation({
    mutationFn: (v: { id: string; profile: Profile }) =>
      call(`/${v.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ profile: v.profile }),
      }),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => call(`/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  return (
    <Stack spacing={3}>
      <Typography variant="h6">Devices</Typography>
      <Typography variant="body2">
        Give each TV box its own login (an app password). Tunarr sizes the
        picture by the device&apos;s profile. Sign in on the device with the
        slug as the username.
      </Typography>

      {created && (
        <Alert severity="success" onClose={() => setCreated(undefined)}>
          Copy this now, it is not shown again. Username:{' '}
          <code>{created.slug}</code> Password: <code>{created.password}</code>
        </Alert>
      )}

      <Stack direction="row" spacing={2} alignItems="center">
        <TextField
          size="small"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          size="small"
          label="Slug (login name)"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          helperText="a-z, 0-9, - _"
        />
        <Select
          size="small"
          value={profile}
          onChange={(e) => setProfile(e.target.value as Profile)}
        >
          {Profiles.map((p) => (
            <MenuItem key={p} value={p}>
              {p}
            </MenuItem>
          ))}
        </Select>
        <Button
          variant="contained"
          disabled={!name || !slug || create.isPending}
          onClick={() => create.mutate()}
        >
          Create
        </Button>
      </Stack>
      {create.error && <Alert severity="error">{create.error.message}</Alert>}

      <Box>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Login</TableCell>
              <TableCell>Profile</TableCell>
              <TableCell>Last seen</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {(data ?? [])
              .filter((d) => !d.revokedAt)
              .map((d) => (
                <TableRow key={d.uuid}>
                  <TableCell>{d.name}</TableCell>
                  <TableCell>{d.slug}</TableCell>
                  <TableCell>
                    <Select
                      size="small"
                      value={d.profile}
                      onChange={(e) =>
                        setProfileFor.mutate({
                          id: d.uuid,
                          profile: e.target.value as Profile,
                        })
                      }
                    >
                      {Profiles.map((p) => (
                        <MenuItem key={p} value={p}>
                          {p}
                        </MenuItem>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>
                    {d.lastSeenAt
                      ? `${new Date(d.lastSeenAt).toLocaleString()} (${d.lastIp ?? ''})`
                      : 'never'}
                  </TableCell>
                  <TableCell>
                    <Button
                      color="error"
                      onClick={() => {
                        if (window.confirm(`Revoke ${d.name}?`)) {
                          revoke.mutate(d.uuid);
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </Box>
    </Stack>
  );
}
