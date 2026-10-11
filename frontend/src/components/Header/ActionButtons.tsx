import { Brightness4, Brightness7, Delete, Download, Settings } from '@mui/icons-material';
import { Badge, Box, IconButton, Tooltip, useMediaQuery, useTheme } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useThemeContext } from '../../contexts/ThemeContext';
import DownloadsMenu from './DownloadsMenu';
import ManageMenu from './ManageMenu';
import { DownloadInfo } from './types';

interface ActionButtonsProps {
    activeDownloads: DownloadInfo[];
    queuedDownloads: DownloadInfo[];
    downloadsAnchorEl: HTMLElement | null;
    manageAnchorEl: HTMLElement | null;
    onDownloadsClick: (event: React.MouseEvent<HTMLElement>) => void;
    onDownloadsClose: () => void;
    onManageClick: (event: React.MouseEvent<HTMLElement>) => void;
    onManageClose: () => void;
    hasActiveSubscriptions?: boolean;
    showThemeButton?: boolean;
}

const ActionButtons: React.FC<ActionButtonsProps> = ({
    activeDownloads,
    queuedDownloads,
    downloadsAnchorEl,
    manageAnchorEl,
    onDownloadsClick,
    onDownloadsClose,
    onManageClick,
    onManageClose,
    hasActiveSubscriptions = false,
    showThemeButton = true
}) => {
    const { mode: currentThemeMode, toggleTheme } = useThemeContext();
    const { t } = useLanguage();
    const { userRole } = useAuth();
    const isVisitor = userRole === 'visitor';
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const isTouch = useMediaQuery('(hover: none), (pointer: coarse)');
    const navigate = useNavigate();

    const handleTrashClick = () => {
        navigate('/manage', { state: { tab: 'trash' } });
    };

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {!isVisitor && (
                <>
                    <IconButton color="inherit" aria-label={t('downloads')} onClick={onDownloadsClick}>
                        <Badge badgeContent={activeDownloads.length + queuedDownloads.length} color="secondary">
                            <Download />
                        </Badge>
                    </IconButton>
                    <DownloadsMenu
                        anchorEl={downloadsAnchorEl}
                        onClose={onDownloadsClose}
                        activeDownloads={activeDownloads}
                        queuedDownloads={queuedDownloads}
                        hasActiveSubscriptions={hasActiveSubscriptions}
                    />
                    <Tooltip title="回收站" disableHoverListener={isTouch}>
                        <IconButton color="inherit" aria-label="trash" onClick={handleTrashClick}>
                            <Delete />
                        </IconButton>
                    </Tooltip>
                </>
            )}

            {showThemeButton && (
                <Tooltip title={t('theme')} disableHoverListener={isTouch}>
                    <IconButton onClick={toggleTheme} color="inherit">
                        {currentThemeMode === 'dark' ? <Brightness7 /> : <Brightness4 />}
                    </IconButton>
                </Tooltip>
            )}

            {!isMobile && (
                <Tooltip title={t('manage')} disableHoverListener={isTouch}>
                    <IconButton
                        color="inherit"
                        onClick={onManageClick}
                    >
                        <Settings />
                    </IconButton>
                </Tooltip>
            )}
            <ManageMenu
                anchorEl={manageAnchorEl}
                onClose={onManageClose}
            />
        </Box>
    );
};

export default ActionButtons;

