/*
BloomPlayerControls wraps BloomPlayerCore and adds just enough controls to preview the
book inside of the Bloom:Publish:Android screen.
*/
import { BloomPlayerCore } from "./bloom-player-core";
import * as ReactDOM from "react-dom";
import {
    requestCapabilities,
    getBookParam,
    onBackClicked
} from "./externalContext";
import { ControlBar } from "./controlBar";
import { ThemeProvider } from "@material-ui/styles";
import theme from "./bloomPlayerTheme";
import React, { useState, useEffect, useRef } from "react";

// This component is designed to wrap a BloomPlayer with some controls
// for things like pausing audio and motion, hiding and showing
// image descriptions. The current version is pretty crude, just enough
// for testing the BloomPlayer narration functions.

interface IProps {
    url: string; // of the bloom book (folder)
    showContextPages?: boolean;
}

export const BloomPlayerControls: React.FunctionComponent<
    IProps & React.HTMLProps<HTMLDivElement>
> = props => {
    const [canGoBack, setCanGoBack] = useState(false);
    const [allowHideAppBar, setAllowHideAppBar] = useState(false);
    const [showAppBar, setShowAppBar] = useState(true);

    const [paused, setPaused] = useState(false);
    const [windowLandscape, setWindowLandscape] = useState(false);
    const [hasAudio, setHasAudio] = useState(false);
    const [hasMusic, setHasMusic] = useState(false);
    const [hasVideo, setHasVideo] = useState(false);
    const [pageStylesInstalled, setPageStylesInstalled] = useState(false);
    const [maxPageDimension, setMaxPageDimension] = useState(0);

    // the point of this is just to have an ever-increasing number; each time the number
    // is increased, it will cause the useEffect to scale the page to the window again.
    const [scalePageToWindowTrigger, setScalePageToWindowTrigger] = useState(0);
    const rerunScalePageToWindow = () => {
        // NB: if we instead said "resizeTrigger+1", the closure would capture the value of
        // scalePageToWindowTrigger the first time through, and so it would never change. So we instead
        // provide a function, and react will supply us with the current value.
        setScalePageToWindowTrigger(currentValue => currentValue + 1);
    };

    useEffect(() => {
        scalePageToWindow();
    }, [pageStylesInstalled, scalePageToWindowTrigger, windowLandscape]);

    useEffect(() => {
        requestCapabilities(data => {
            setAllowHideAppBar(data.allowHideAppBar || false);
            setCanGoBack(data.canGoBack);
        });
    }, []);

    // Assumes that we want the controls and player to fill a (typically device) window.
    // (The page is trying to be a standard height (in mm) for a predictable layout
    // that does not depend on how text of a particular point size fits onto a
    // screen of a particular size. But we don't want to have to scroll to see it all.)
    // We want to scale it so that it and the controls fit the window.
    // On a very large screen like a tablet this might even scale it bigger.
    const scalePageToWindow = () => {
        // We need to work from the page that is currently visible. Others may not have the right
        // orientation class set.
        const currentSlickElt = document.getElementsByClassName(
            "slick-current"
        )[0] as HTMLElement;
        let page: HTMLElement | null = null;
        if (currentSlickElt) {
            page = currentSlickElt.getElementsByClassName(
                "bloom-page"
            )[0] as HTMLElement;
        }
        // note that these are independent: we could have received a pageStylesInstalled signal, but
        // the page isn't loaded in the slider yet.
        if (!page || !pageStylesInstalled) {
            // may well be called before the book is sufficiently loaded
            // for a page to be found (or before the styles are loaded that set its page size).
            // If so, keep trying until all is ready.
            // We want to check pretty frequently so that we don't display the wrong size
            // version of the page.
            window.setTimeout(rerunScalePageToWindow, 100);
            return; // can't do any useful scaling (yet)
        }

        // Make a stylesheet that causes bloom pages to be the size we want.
        let scaleStyleSheet = document.getElementById("scale-style-sheet");
        const firstTimeThrough = !scaleStyleSheet;
        if (!scaleStyleSheet) {
            scaleStyleSheet = document.createElement("style");
            scaleStyleSheet.setAttribute("type", "text/css");
            scaleStyleSheet.setAttribute("id", "scale-style-sheet");
            document.head!.appendChild(scaleStyleSheet);
        }
        // The first time through, we compute this, afterwards we get it from the state.
        // There has to be a better way to do this, probably a separate useEffect to compute maxPageDimension.
        let localMaxPageDimension = maxPageDimension;
        if (firstTimeThrough) {
            // Some other one-time stuff:
            // Arrange for this to keep being called when the window size changes.
            window.onresize = () => {
                // we don't want to call this inside a closure, because then we get
                // a bunch of stale state, so we use the react
                // hooks system to trigger this in a useEffect()
                rerunScalePageToWindow();
            };

            // I'm not sure if this is necessary, but capturing the page size in pixels on this
            // device before we start scaling and rotating it seems to make things more stable.
            localMaxPageDimension = Math.max(
                page.offsetHeight,
                page.offsetWidth
            );
            // save for future use
            setMaxPageDimension(localMaxPageDimension);
        }
        const winHeight = window.innerHeight; // total physical space allocated to WebView/iframe
        const desiredWindowLandscape = window.innerWidth > winHeight;
        if (desiredWindowLandscape !== windowLandscape) {
            setWindowLandscape(desiredWindowLandscape); // will result in another call from useEffect
            return;
        }
        // enhance: maybe we just want to force the automatic browser margins to zero?
        let topMargin = 0;
        let bottomMargin = 0;
        const style = window.getComputedStyle(document.body);
        if (style && style.marginTop) {
            topMargin = parseInt(style.marginTop, 10);
        }
        if (style && style.marginBottom) {
            bottomMargin = parseInt(style.marginBottom, 10);
        }

        const landscape = page.getAttribute("class")!.indexOf("Landscape") >= 0;

        const pageHeight = landscape
            ? (localMaxPageDimension * 9) / 16
            : localMaxPageDimension;
        // The current height of whatever must share the page with the adjusted document
        // At one point this could include some visible controls.
        // It almost works to compute
        // const docHeight = document.body.offsetHeight + topMargin + bottomMargin;
        // and then controlsHeight = docHeight - pageHeight.
        // However, sometimes there are pages (not currently visible) in the wrong orientation.
        // This can make document.body.offsetHeight unexpectedly big.
        // For now we are hard-coding that the only thing not part of the document is any
        // margins on the body and the appbar.
        let controlsHeight = topMargin + bottomMargin;
        if (showAppBar) {
            const appbar = document.getElementById("control-bar");
            if (appbar) {
                controlsHeight += appbar.offsetHeight;
            }
        }
        // How high the document needs to be to make it and the controls fit the window
        const desiredPageHeight = winHeight - controlsHeight;
        let scaleFactor = desiredPageHeight / pageHeight;

        // Similarly compute how we'd have to scale to fit horizontally.
        // Not currently trying to allow for controls left or right of page.
        const pageWidth = landscape
            ? localMaxPageDimension
            : (localMaxPageDimension * 9) / 16;
        const desiredPageWidth = document.body.offsetWidth;
        const horizontalScaleFactor = desiredPageWidth / pageWidth;
        scaleFactor = Math.min(scaleFactor, horizontalScaleFactor);
        const actualPageHeight = pageHeight * scaleFactor;

        let width = (actualPageHeight * 9) / 16 / scaleFactor;
        if (landscape) {
            width = (actualPageHeight * 16) / 9 / scaleFactor;
        }

        // how much horizontal space do we have to spare, in the scaled pixels
        // which control the button size?
        const widthMargin = window.innerWidth / scaleFactor - width;
        const player = document.getElementsByClassName("bloomPlayer")[0];
        // To put the buttons outside, we need twice @navigationButtonWidth,
        // as defined in bloom-player.less.
        player.classList.remove("largeOutsideButtons");
        player.classList.remove("smallOutsideButtons");

        // should match that defined in bloom-player.less
        const smallNavigationButtonWidth = 30;
        const largeNavigationButtonWidth = 100;
        if (widthMargin > largeNavigationButtonWidth * 2) {
            // We have two button widths to spare; can put buttons outside phone
            player.classList.add("largeOutsideButtons");
        } else if (widthMargin > smallNavigationButtonWidth * 2) {
            player.classList.add("smallOutsideButtons");
        }

        const leftMargin = Math.max(
            (window.innerWidth - pageWidth * scaleFactor) / 2,
            0
        );
        // OK, this is a bit tricky.
        // First, we want to scale the whole bloomPlayer control by the scaleFactor we just computed
        // (relative to the top left). That's the two 'transform' rules.
        // Now, by default the player adjusts its width to the window. If we then scale that width,
        // the bloom page will fill the window, but the control will be wider or narrower, and
        // the right-hand page button will be inside the page or scrolled off to the right.
        // So we set the width of the bloom player to the width we just computed, which is calculated
        // to reverse the effect of the scaling we applied, so the scaling will make it fit the window.
        // Next problem is that some of the (not visible) pages may not have the same height as the
        // one(s) we are looking at, because we only adjust the orientation of the current page.
        // That can leave the overall height of the carousel determined by a portrait page even
        // though we're looking at it in landscape, resulting in scroll bars and misplaced
        // page turning buttons. So we force all the actual page previews to be no bigger than
        // the height we expect and hide their overflow to fix
        scaleStyleSheet.innerText = `.bloomPlayer {
            width: ${width}px;
            transform-origin: left top 0;
            transform: scale(${scaleFactor});
            margin-left: ${leftMargin}px;
        }
        .actual-page-preview {height: ${actualPageHeight /
            scaleFactor}px; overflow: hidden;}`;
    };

    return (
        <div
            {...props} // Allow all standard div props
        >
            <ControlBar
                canGoBack={canGoBack}
                visible={showAppBar}
                paused={paused}
                pausedChanged={(p: boolean) => setPaused(p)}
                backClicked={() => onBackClicked()}
                showPlayPause={hasAudio || hasMusic || hasVideo}
            />
            <BloomPlayerCore
                url={props.url}
                landscape={windowLandscape}
                showContextPages={props.showContextPages}
                paused={paused}
                pageStylesAreNowInstalled={() => {
                    setPageStylesInstalled(true);
                }}
                reportBookProperties={bookProps => {
                    // Inform parent window when in an iframe.
                    if (window.parent) {
                        window.parent.postMessage(
                            {
                                landscape: bookProps.landscape,
                                canRotate: bookProps.canRotate
                            },
                            "*"
                        );
                    }
                    // So far there's no way (or need) to inform whatever set up a WebView.
                    //No! setWindowLandscape is about the window's orientation, not the book's: setWindowLandscape(bookProps.landscape);
                }}
                reportPageProperties={pageProps => {
                    setHasAudio(pageProps.hasAudio);
                    setHasMusic(pageProps.hasMusic);
                    setHasVideo(pageProps.hasVideo);
                }}
                onContentClick={e => {
                    if (allowHideAppBar) {
                        setShowAppBar(!showAppBar);
                        // Note: we could get the useEffect() to run this by listing
                        // showAppBar in its array of things to watch, but we
                        // really need wait for the animation of hiding the bar to finish first.
                        const kCssTransitionTime = 300;
                        window.setTimeout(
                            rerunScalePageToWindow,
                            // just a moment after the animation is done
                            kCssTransitionTime + 50
                        );
                    }
                }}
            />
        </div>
    );
};

// a bit goofy...we need some way to get react called when this code is loaded into an HTML
// document (as part of bloomPlayerControlBundle.js). When that module is loaded, any
// not-in-a-class code gets called. So we arrange here for a bit of it to turn any element
// with class bloom-player-controls into a React element of that type.

export function InitBloomPlayerControls() {
    ReactDOM.render(
        <ThemeProvider theme={theme}>
            <BloomPlayerControls url={getBookParam("url")} />
        </ThemeProvider>,
        document.getElementById("root")
    );
}
