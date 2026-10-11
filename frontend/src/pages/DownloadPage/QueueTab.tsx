import { ClearAll as ClearAllIcon, Delete as DeleteIcon, Pause as PauseIcon, PlayArrow as PlayArrowIcon } from '@mui/icons-material';
import {
    Box,
    Button,
    IconButton,
    List,
    ListItem,
    ListItemText,
    Pagination,
    Paper,
    Typography
} from '@mui/material';
import React, { useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { useMediaQuery, useTheme } from '@mui/material';

interface Download {
    id: string;
    title: string;
    progress?: number;
    downloadedSize?: string;
    totalSize?: string;
}

interface QueueTabProps {
    downloads: Download[];
    pausedDownloads?: Download[];
    onRemove: (id: string) => void;
    onClear: () => void;
    onPause?: (id: string) => void;
    onResume?: (id: string) => void;
    onDeletePaused?: (id: string) => void;
}

const ITEMS_PER_PAGE = 20;

export function QueueTab({ downloads, pausedDownloads = [], onRemove, onClear, onPause, onResume, onDeletePaused }: QueueTabProps) {
    const { t } = useLanguage();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
    const [page, setPage] = useState(1);

    return (
        <>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
                <Button
                    variant="outlined"
                    startIcon={<ClearAllIcon />}
                    onClick={onClear}
                    disabled={downloads.length === 0}
                >
                    {t('clearQueue') || 'Clear Queue'}
                </Button>
            </Box>
            {downloads.length === 0 && pausedDownloads.length === 0 ? (
                <Typography color="textSecondary">{t('noQueuedDownloads') || 'No queued downloads'}</Typography>
            ) : (
                <>
                    {downloads.length > 0 && (
                        <List>
                            {downloads
                                .slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)
                                .map((download) => (
                                    <Paper key={download.id} sx={{ mb: 2, p: 2 }}>
                                        <ListItem
                                            disableGutters
                                            secondaryAction={
                                                <Box>
                                                    {onPause && (
                                                        <IconButton
                                                            edge={false}
                                                            aria-label="pause"
                                                            onClick={() => onPause(download.id)}
                                                            title={t('pause') || 'Pause'}
                                                        >
                                                            <PauseIcon />
                                                        </IconButton>
                                                    )}
                                                    <IconButton
                                                        edge="end"
                                                        aria-label="remove"
                                                        onClick={() => onRemove(download.id)}
                                                        title={t('remove') || 'Remove'}
                                                    >
                                                        <DeleteIcon />
                                                    </IconButton>
                                                </Box>
                                            }
                                        >
                                            <ListItemText
                                                primary={download.title}
                                                secondary={t('queued') || 'Queued'}
                                            />
                                        </ListItem>
                                    </Paper>
                                ))}
                        </List>
                    )}
                    {downloads.length > ITEMS_PER_PAGE && (
                        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                            <Pagination
                                count={Math.ceil(downloads.length / ITEMS_PER_PAGE)}
                                page={page}
                                onChange={(_: React.ChangeEvent<unknown>, newPage: number) => setPage(newPage)}
                                color="primary"
                                siblingCount={isMobile ? 0 : 1}
                            />
                        </Box>
                    )}
                    {pausedDownloads.length > 0 && (
                        <Box sx={{ mt: downloads.length > 0 ? 3 : 0 }}>
                            <Typography variant="subtitle1" fontWeight="bold" sx={{ mb: 1 }}>
                                {t('pausedDownloads') || 'Paused'} ({pausedDownloads.length})
                            </Typography>
                            <List>
                                {pausedDownloads.map((download) => (
                                    <Paper
                                        key={download.id}
                                        sx={{
                                            mb: 2,
                                            p: 2,
                                            bgcolor: 'action.hover',
                                        }}
                                    >
                                        <ListItem
                                            disableGutters
                                            secondaryAction={
                                                <Box>
                                                    {onResume && (
                                                        <IconButton
                                                            edge={false}
                                                            aria-label="resume"
                                                            color="primary"
                                                            onClick={() => onResume(download.id)}
                                                            title={t('resume') || 'Resume'}
                                                        >
                                                            <PlayArrowIcon />
                                                        </IconButton>
                                                    )}
                                                    {onDeletePaused && (
                                                        <IconButton
                                                            edge="end"
                                                            aria-label="delete-paused"
                                                            onClick={() => onDeletePaused(download.id)}
                                                            title={t('cancel') || 'Cancel'}
                                                        >
                                                            <DeleteIcon />
                                                        </IconButton>
                                                    )}
                                                </Box>
                                            }
                                        >
                                            <ListItemText
                                                primary={download.title}
                                                secondary={
                                                    typeof download.progress === 'number' && download.progress > 0
                                                        ? `${t('pausedDownloads') || 'Paused'} · ${download.progress.toFixed(0)}%${download.downloadedSize ? ` · ${download.downloadedSize}` : ''}${download.totalSize ? ` / ${download.totalSize}` : ''}`
                                                        : (t('pausedDownloads') || 'Paused')
                                                }
                                            />
                                        </ListItem>
                                    </Paper>
                                ))}
                            </List>
                        </Box>
                    )}
                </>
            )}
        </>
    );
}
