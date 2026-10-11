import {
    Box,
    Button,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Typography,
} from '@mui/material';
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../utils/apiClient';
import { useSnackbar } from '../../contexts/SnackbarContext';
import { formatSize } from '../../utils/formatUtils';

type TrashItem = {
    id: string;
    videoId: string;
    title: string;
    author: string | null;
    fileSize: number | null;
    deletedAt: number;
    expiresAt: number;
};

const DAYS_LEFT = (expiresAt: number) =>
    Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000));

export const TrashPanel: React.FC = () => {
    const { showSnackbar } = useSnackbar();
    const queryClient = useQueryClient();
    const [actingId, setActingId] = useState<string | null>(null);

    const trashQuery = useQuery({
        queryKey: ['trash'],
        queryFn: async () => {
            const res = await api.get('/trash');
            return (res.data?.items ?? []) as TrashItem[];
        },
    });

    const restoreMutation = useMutation({
        mutationFn: async (id: string) => {
            const res = await api.post(`/trash/${id}/restore`);
            return res.data;
        },
        onSuccess: () => {
            showSnackbar('已恢复到媒体库', 'success');
            queryClient.invalidateQueries({ queryKey: ['trash'] });
            queryClient.invalidateQueries({ queryKey: ['videos'] });
        },
        onError: (error: any) => {
            showSnackbar(`恢复失败: ${error.response?.data?.error || error.message}`, 'error');
        }
    });

    const purgeMutation = useMutation({
        mutationFn: async (id: string) => {
            const res = await api.delete(`/trash/${id}`);
            return res.data;
        },
        onSuccess: () => {
            showSnackbar('已彻底删除', 'success');
            queryClient.invalidateQueries({ queryKey: ['trash'] });
        },
        onError: (error: any) => {
            showSnackbar(`删除失败: ${error.response?.data?.error || error.message}`, 'error');
        }
    });

    const items = trashQuery.data ?? [];

    const handleRestore = (id: string) => {
        setActingId(id);
        restoreMutation.mutate(id, { onSettled: () => setActingId(null) });
    };

    const handlePurge = (id: string) => {
        setActingId(id);
        purgeMutation.mutate(id, { onSettled: () => setActingId(null) });
    };

    if (trashQuery.isLoading) {
        return (
            <Box sx={{ py: 4, textAlign: 'center' }}>
                <Typography color="text.secondary">加载中…</Typography>
            </Box>
        );
    }

    if (items.length === 0) {
        return (
            <Box sx={{ py: 4, textAlign: 'center' }}>
                <Typography color="text.secondary">回收站为空。删除的视频会在这里保留 7 天，可随时恢复。</Typography>
            </Box>
        );
    }

    return (
        <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                删除的视频在此保留 7 天，过期自动彻底删除。恢复后视频回到原合集位置。
            </Typography>
            <TableContainer>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>标题</TableCell>
                            <TableCell>作者</TableCell>
                            <TableCell>大小</TableCell>
                            <TableCell>删除时间</TableCell>
                            <TableCell>剩余保留</TableCell>
                            <TableCell align="right">操作</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {items.map((item) => (
                            <TableRow key={item.id}>
                                <TableCell>{item.title}</TableCell>
                                <TableCell>{item.author || '-'}</TableCell>
                                <TableCell>{item.fileSize ? formatSize(item.fileSize) : '-'}</TableCell>
                                <TableCell>{new Date(item.deletedAt).toLocaleString()}</TableCell>
                                <TableCell>{DAYS_LEFT(item.expiresAt)} 天</TableCell>
                                <TableCell align="right">
                                    <Button
                                        size="small"
                                        variant="outlined"
                                        sx={{ mr: 1 }}
                                        disabled={actingId === item.id}
                                        onClick={() => handleRestore(item.id)}
                                    >
                                        恢复
                                    </Button>
                                    <Button
                                        size="small"
                                        variant="outlined"
                                        color="error"
                                        disabled={actingId === item.id}
                                        onClick={() => handlePurge(item.id)}
                                    >
                                        彻底删除
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        </Box>
    );
};
