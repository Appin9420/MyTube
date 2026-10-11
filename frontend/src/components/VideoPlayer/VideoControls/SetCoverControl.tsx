import { CameraAlt } from '@mui/icons-material';
import { IconButton, Tooltip, useMediaQuery } from '@mui/material';
import React from 'react';
import { useLanguage } from '../../../contexts/LanguageContext';

interface SetCoverControlProps {
    onSetCover: () => void;
}

const SetCoverControl: React.FC<SetCoverControlProps> = ({
    onSetCover
}) => {
    const { t } = useLanguage();
    const isTouch = useMediaQuery('(hover: none), (pointer: coarse)');

    return (
        <Tooltip title={t('setAsCover') || 'Set current frame as cover'} disableHoverListener={isTouch}>
            <IconButton
                color="default"
                onClick={onSetCover}
                size="small"
            >
                <CameraAlt />
            </IconButton>
        </Tooltip>
    );
};

export default SetCoverControl;
