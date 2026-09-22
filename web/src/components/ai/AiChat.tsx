import {
  useAiChat,
  useGenerateChannel,
  type AiChatMessage,
} from '@/hooks/useAi.ts';
import { AutoFixHigh, Send } from '@mui/icons-material';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Typography,
  TextField,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { useCallback, useRef, useState } from 'react';

interface ParsedMessage {
  text: string;
  action?: { type: string; prompt: string };
}

function parseMessage(raw: string): ParsedMessage {
  const match = raw.match(/<action>([\s\S]*?)<\/action>/);
  if (!match) return { text: raw };
  const text = raw.replace(/<action>[\s\S]*?<\/action>/, '').trim();
  try {
    const action = JSON.parse(match[1]) as { type: string; prompt: string };
    return { text, action };
  } catch {
    return { text: raw };
  }
}

function ActionButton({ prompt }: { prompt: string }) {
  const generate = useGenerateChannel();
  const { enqueueSnackbar } = useSnackbar();

  const handleCreate = () => {
    generate.mutate(
      prompt,
      {
        onSuccess: (data) => {
          enqueueSnackbar(
            `Channel "${data.name}" created with ${data.programCount} programs!`,
            { variant: 'success' },
          );
        },
        onError: (err) => {
          enqueueSnackbar(err.message, { variant: 'error' });
        },
      },
    );
  };

  return (
    <Button
      variant="contained"
      size="small"
      startIcon={
        generate.isPending ? (
          <CircularProgress size={14} color="inherit" />
        ) : (
          <AutoFixHigh />
        )
      }
      onClick={handleCreate}
      disabled={generate.isPending || generate.isSuccess}
      sx={{ mt: 1 }}
    >
      {generate.isSuccess
        ? 'Channel Created!'
        : generate.isPending
          ? 'Creating...'
          : 'Create Channel'}
    </Button>
  );
}

export function AiChat() {
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState('');
  const chat = useAiChat();
  const { enqueueSnackbar } = useSnackbar();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleSend = () => {
    const text = input.trim();
    if (!text || chat.isPending) return;

    const newMessages: AiChatMessage[] = [
      ...messages,
      { role: 'user', content: text },
    ];
    setMessages(newMessages);
    setInput('');

    chat.mutate(newMessages, {
      onSuccess: (data) => {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: data.message },
        ]);
        setTimeout(scrollToBottom, 50);
      },
      onError: (err) => {
        enqueueSnackbar(err.message, { variant: 'error' });
      },
    });

    setTimeout(scrollToBottom, 50);
  };

  return (
    <Stack spacing={2} sx={{ height: '60vh' }}>
      <Box sx={{ flex: 1, overflowY: 'auto', p: 1 }}>
        {messages.length === 0 && (
          <Typography
            color="text.secondary"
            sx={{ textAlign: 'center', mt: 4 }}
          >
            Ask about your library, get channel ideas, or request changes.
          </Typography>
        )}
        {messages.map((msg, i) => {
          const parsed =
            msg.role === 'assistant' ? parseMessage(msg.content) : null;
          return (
            <Box
              key={i}
              sx={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                mb: 1,
              }}
            >
              <Paper
                sx={{
                  p: 1.5,
                  maxWidth: '75%',
                  bgcolor: msg.role === 'user' ? 'primary.main' : 'grey.800',
                  color: 'white',
                }}
              >
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                  {parsed ? parsed.text : msg.content}
                </Typography>
                {parsed?.action?.type === 'create_channel' && (
                  <ActionButton prompt={parsed.action.prompt} />
                )}
              </Paper>
            </Box>
          );
        })}
        {chat.isPending && (
          <Box sx={{ display: 'flex', justifyContent: 'flex-start', mb: 1 }}>
            <CircularProgress size={24} />
          </Box>
        )}
        <div ref={messagesEndRef} />
      </Box>
      <Stack direction="row" spacing={1}>
        <TextField
          fullWidth
          size="small"
          placeholder="e.g. Create a 90s sitcom channel..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={chat.isPending}
        />
        <IconButton
          onClick={handleSend}
          disabled={chat.isPending || !input.trim()}
        >
          <Send />
        </IconButton>
      </Stack>
    </Stack>
  );
}
