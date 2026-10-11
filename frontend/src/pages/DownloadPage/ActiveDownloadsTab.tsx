import { Cancel as CancelIcon, Pause as PauseIcon } from '@mui/icons-material';
import {
    Box,
    IconButton,
    LinearProgress,
    List,
    ListItem,
    ListItemText,
    Paper,
    Typography
} from '@mui/material';
import { useLanguage } from '../../contexts/LanguageContext';

interface Download {
    id: string;
    title: string;
    progress?: number;
    speed?: string;
    downloadedSize?: string;
    totalSize?: string;
    phase?: string;
}

interface ActiveDownloadsTabProps {
    downloads: Download[];
    onCancel: (id: string) => void;
    onPause: (id: string) => void;
}

export function ActiveDownloadsTab({ downloads, onCancel, onPause }: ActiveDownloadsTabProps) {
    const { t } = useLanguage();

    if (downloads.length === 0) {
        return <Typography color="textSecondary">{t('noActiveDownloads') || 'No active downloads'}</Typography>;
    }

    return (
        <List>
            {downloads.map((download) => (
                <Paper key={download.id} sx={{ mb: 2, p: 2 }}>
                    <ListItem
                        disableGutters
                        secondaryAction={
                            <Box>
                                <IconButton
                                    edge={false}
                                    aria-label="pause"
                                    onClick={() => onPause(download.id)}
                                    title={t('pause') || 'Pause'}
                                >
                                    <PauseIcon />
                                </IconButton>
                                <IconButton
                                    edge="end"
                                    aria-label="cancel"
                                    onClick={() => onCancel(download.id)}
                                    title={t('cancel') || 'Cancel'}
                                >
                                    <CancelIcon />
                                </IconButton>
                            </Box>
                        }
                    >
                        <ListItemText
                            primary={download.title}
                            slotProps={{ secondary: { component: 'div' } }}
                            secondary={
                                <Box sx={{ mt: 1 }}>
                                    <LinearProgress variant="determinate" value={download.progress || 0} sx={{ mb: 1 }} />
                                    {download.phase === 'merging' && (
                                        <Typography variant="caption" sx={{ display: 'block', mb: 0.5, color: 'warning.main' }}>
                                            {t('downloadMerging') || 'Merging segments…'}
                                        </Typography>
                                    )}
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                        <Typography variant="body2" fontWeight="bold" color="primary">
                                            {download.progress?.toFixed(1)}%
                                        </Typography>
                                        <Typography variant="caption" color="textSecondary">
                                            •
                                        </Typography>
                                        <Typography variant="caption" color="textSecondary">
                                            {download.speed || '0 B/s'}
                                        </Typography>
                                        <Typography variant="caption" color="textSecondary">
                                            •
                                        </Typography>
                                        <Typography variant="caption" color="textSecondary">
                                            {download.downloadedSize || '0'} / {download.totalSize || '?'}
                                        </Typography>
                                    </Box>
                                </Box>
                            }
                        />
                    </ListItem>
                </Paper>
            ))}
        </List>
    );
}
