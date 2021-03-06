import * as React from "react";

// We'd prefer to use this more elegant form of import:
//import { AppBar, Toolbar, IconButton } from "@material-ui/core";
// import {
//     ArrowBack,
//     PlayCircleOutline,
//     PauseCircleOutline
// } from "@material-ui/icons";
// However, @material-ui doc indicates that the second-level imports are supported,
// and using the first-level ones has unfortunate consequences on build times and sizes.
// It takes roughly twice as long to build our bundles, and they end up roughly
// ten times bigger, and the extra time to load those bigger bundles is definitely
// noticeable.
// The latter two effects probably indicate that I have not yet figured out how to
// configure webpack to really do tree-shaking, even in our production build.

//tslint:disable-next-line:no-submodule-imports
import AppBar from "@material-ui/core/AppBar";
//tslint:disable-next-line:no-submodule-imports
import Toolbar from "@material-ui/core/Toolbar";
//tslint:disable-next-line:no-submodule-imports
import IconButton from "@material-ui/core/IconButton";
//tslint:disable-next-line:no-submodule-imports
import ArrowBack from "@material-ui/icons/ArrowBack";
//tslint:disable-next-line:no-submodule-imports
import PlayCircleOutline from "@material-ui/icons/PlayCircleOutline";
//tslint:disable-next-line:no-submodule-imports
import PauseCircleOutline from "@material-ui/icons/PauseCircleOutline";

// react control (using hooks) for the bar of controls across the top of a bloom-player-controls

interface IControlBarProps {
    visible: boolean; // will slide into / out of view based on this
    paused: boolean;
    pausedChanged?: (b: boolean) => void;
    showPlayPause: boolean;
    backClicked?: () => void;
    canGoBack: boolean;
}

export const ControlBar: React.FunctionComponent<IControlBarProps> = props => {
    const playOrPause = props.paused ? (
        <PlayCircleOutline />
    ) : (
        <PauseCircleOutline />
    );

    return (
        <AppBar
            color="primary"
            className={`control-bar ${props.visible ? ", visible" : ""}`}
            id="control-bar"
            elevation={0}
            position="relative" // Keeps the AppBar from floating
        >
            <Toolbar>
                {props.canGoBack && (
                    <IconButton
                        color="secondary"
                        onClick={() => {
                            if (props.backClicked) {
                                props.backClicked();
                            }
                        }}
                    >
                        <ArrowBack />
                    </IconButton>
                )}
                <div
                    className="filler" // this is set to flex-grow, making the following icons right-aligned.
                />
                <IconButton
                    color="secondary"
                    onClick={() => {
                        if (props.pausedChanged) {
                            props.pausedChanged(!props.paused);
                        }
                    }}
                >
                    {props.showPlayPause ? playOrPause : null}
                </IconButton>
            </Toolbar>
        </AppBar>
    );
};
