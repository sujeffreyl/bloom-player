import LiteEvent from "./event";

// Handles implemenation of narration, including playing the audio and
// highlighting the currently playing text.
// Enhance: There's code here to support PageNarrationComplete for auto-advance,
// but that isn't implemented yet so it may not be complete.
// May need to copy more pieces from old BloomPlayer.
// Enhance: Pause is a prop for this control, but somehow we need to
// notify the container if we are paused forcibly by Chrome refusing to
// let us play until the user interacts with the page.
export default class Narration {
    private playerPage: HTMLElement;
    private paused: boolean = false;
    public urlPrefix: string;
    // The time we started to play the current page (set in computeDuration, adjusted for pauses)
    private startPlay: Date;
    private startPause: Date;
    private fakeNarrationAborted: boolean = false;
    private segmentIndex: number;

    private segments: HTMLElement[];

    // The first one to play should be at the end for both of these
    private nextElementIdToPlay: string;
    private elementsToPlayConsecutivelyStack: HTMLElement[];
    private endTimesInSecsStack: number[];
    private elementsToHighlightStack: Element[];

    public PageNarrationComplete: LiteEvent<HTMLElement>;
    public PageDurationAvailable: LiteEvent<HTMLElement>;
    public PageDuration: number;

    constructor() {
        // Initialize them here to be safe
        this.elementsToHighlightStack = [];
        this.endTimesInSecsStack = [];
    }

    // Roughly equivalent to BloomDesktop's AudioRecording::listen() function.
    public playAllSentences(page: HTMLElement): void {
        this.playerPage = page;

        this.elementsToPlayConsecutivelyStack = this.getPageAudioElements().reverse();

        const stackSize = this.elementsToPlayConsecutivelyStack.length;
        if (stackSize === 0) {
            // Nothing to play
            if (this.PageNarrationComplete) {
                this.PageNarrationComplete.raise();
            }
            return;
        }
        const firstElementToPlay = this.elementsToPlayConsecutivelyStack[
            stackSize - 1
        ]; // Remember to pop it when you're done playing it. (i.e., in playEnded)

        this.setCurrentAudioElement(firstElementToPlay, true);
        this.playCurrentInternal();
    }

    private playCurrentInternal() {
        if (!this.paused) {
            const mediaPlayer = this.getPlayer();
            if (mediaPlayer) {
                const element = this.playerPage.querySelector(`#${this.nextElementIdToPlay}`);
                if (!element || !this.canPlayAudio(element)) {
                    this.playEnded();
                    return;
                }

                const timingsStr: string | null = element.getAttribute("data-audioRecordingEndTimes");
                if (timingsStr) {
                    const fields = timingsStr.split(" ");

                    let parsedSuccessfully = true;
                    this.endTimesInSecsStack = [];
                    for (let i = fields.length - 1; i >= 0; --i) {
                        const numberField: number = Number(fields[i]);
                        if (isNaN(numberField)) {
                            parsedSuccessfully = false;
                            break;
                        }
                        this.endTimesInSecsStack.push(numberField);
                    }

                    if (parsedSuccessfully) {
                        const childSpanElements = element.querySelectorAll("span.sentence");

                        this.elementsToHighlightStack = [];
                        for (let i = childSpanElements.length - 1; i >= 0 ; --i) {
                            this.elementsToHighlightStack.push(childSpanElements.item(i));
                        }
                    }
                }

                const promise = mediaPlayer.play();
                this.playNextSubElement();

                // In newer browsers, play() returns a promise which fails
                // if the browser disobeys the command to play, as some do
                // if the user hasn't 'interacted' with the page in some
                // way that makes the browser think they are OK with it
                // playing audio. In Gecko45, the return value is undefined,
                // so we mustn't call catch.
                if (promise && promise.catch) {
                    promise.catch((reason: any) => {
                        console.log("could not play sound: " + reason);

                        // REVIEW: Don't think the following code is needed?
                        // If the promise fails, shouldn't the error handler go at it?
                        // Well, definitely don't want removeAudioCurrent(). That'll mess up the playEnded() call.
                        // Maybe pausing it isn't a terrible idea.

                        // this.removeAudioCurrent();
                        // With some kinds of invalid sound file it keeps trying and plays over and over.

                        // REVIEW: I don't think this line actually helps anything, so I commented it out.
                        // this.getPlayer().pause();
                        // if (this.Pause) {
                        //     this.Pause.raise();
                        // }
                    });
                }
            }
        }
    }

    private playNextSubElement() {
        // the item should not be popped off the stack until it's completely done with.
        const highlightCount = this.elementsToHighlightStack.length;
        const endTimesCount = this.endTimesInSecsStack.length;

        if (highlightCount <= 0 || endTimesCount <= 0) {
            return;
        }

        const endTimeInSecs: number = this.endTimesInSecsStack[endTimesCount - 1];
        const element:Element = this.elementsToHighlightStack[highlightCount - 1];

        this.setCurrentAudioElement(element, false, false);  // 3rd parameter (updateAudioPlayer) needs to be false so that playing the 2md sentence doesn't restart the audio playback from the beginning of th etext box

        let currentTimeInSecs: number;
        const mediaPlayer: HTMLMediaElement = (document.getElementById("bloom-audio-player")! as HTMLMediaElement);
        currentTimeInSecs = mediaPlayer.currentTime;

        let durationInSecs = endTimeInSecs - currentTimeInSecs;

        // Handle cases where the currentTime has already exceeded the nextStartTime
        //   (might happen if you're unlucky in the thread queue... or if in debugger, etc.)
        const minHighlightThresholdInSecs = 0.1;
        if (durationInSecs <= minHighlightThresholdInSecs) {
            durationInSecs = minHighlightThresholdInSecs;
        }

        setTimeout(() => {
            this.playSubElementEnded();
        }, durationInSecs * 1000);
    }

    private playSubElementEnded() {
        if (this.endTimesInSecsStack.length <= 0) {
            return;
        }

        const mediaPlayer: HTMLMediaElement = document.getElementById("bloom-audio-player")! as HTMLMediaElement;
        if (mediaPlayer.ended || mediaPlayer.error) {
            return;
        }
        const playedDurationInSecs: number | undefined | null = mediaPlayer.currentTime;

        // Peek at the next sentence and see if we're ready to start that one. (We might not be ready to play the next audio if the current audio got paused).
        const nextStartTimeInSecs = this.endTimesInSecsStack[this.endTimesInSecsStack.length - 1];
        if (playedDurationInSecs && playedDurationInSecs < nextStartTimeInSecs) {
            // Still need to wait. Exit this function early and re-check later.
            const minRemainingDurationInSecs = nextStartTimeInSecs - playedDurationInSecs;
            setTimeout(() => {
                this.playSubElementEnded();
            }, minRemainingDurationInSecs * 1000);

            return;
        }

        this.endTimesInSecsStack.pop();
        this.elementsToHighlightStack.pop();

        this.playNextSubElement();
    }

    // Equivalent of removeAudioCurrentFromPageDocBody() in BloomDesktop.
    private removeAudioCurrent() {
        // Note that HTMLCollectionOf's length can change if you change the number of elements matching the selector.
        const audioCurrentCollection: HTMLCollectionOf<Element> = document.getElementsByClassName("ui-audioCurrent");

        // Convert to an array whose length won't be changed
        const audioCurrentArray: Element[] = Array.prototype.slice.call(audioCurrentCollection);

        for (let i = 0; i < audioCurrentArray.length; i++) {
            audioCurrentArray[i].classList.remove("ui-audioCurrent");
        }
    }

    private setCurrentAudioElement(
        elementToChangeTo: Element,
        disableHighlightIfNoAudio?: boolean,
        updateAudioPlayer: boolean = true
    ): void {
        const firstExistingAudioCurrentElement: Element | null = this.playerPage.querySelector(".ui-audioCurrent");

        this.setCurrentAudioElementFrom(
            firstExistingAudioCurrentElement,
            elementToChangeTo,
            disableHighlightIfNoAudio,
            updateAudioPlayer
        );
    }

    private setCurrentAudioElementFrom(
        currentElement: Element | null | undefined,
        elementToChangeTo: Element,
        disableHighlightIfNoAudio,
        updateAudioPlayer: boolean = true
    ): void {
        if (currentElement == elementToChangeTo) {
            // No need to do much, and better not to, so that we can avoid any temporary flashes as the highlight is removed and re-applied
            this.setNextElementIdToPlay(elementToChangeTo.id, updateAudioPlayer);
            return;
        }

        this.removeAudioCurrent();

        if (disableHighlightIfNoAudio) {
            const mediaPlayer = this.getPlayer();
            const isAlreadyPlaying = mediaPlayer.currentTime > 0;

            // If it's already playing, no need to disable (Especially in the Soft Split case, where only one file is playing but multiple sentences need to be highlighted).
            if (!isAlreadyPlaying) {
                // Start off in a highlight-disabled state so we don't display any momentary highlight for cases where there is no audio for this element.
                // In react-based bloom-player, canPlayAudio() can't trivially identify whether or not audio exists,
                // so we need to incorporate a derivative of Bloom Desktop's disableHighlight code
                elementToChangeTo.classList.add("disableHighlight");
                const mediaPlayer = this.getPlayer();
                mediaPlayer.addEventListener('playing', (event) => {
                    elementToChangeTo.classList.remove("disableHighlight");
                });
            }
        }

        elementToChangeTo.classList.add("ui-audioCurrent");

        this.setNextElementIdToPlay(elementToChangeTo.id, updateAudioPlayer);
    }

    // Setter for idOfNextElementToPlay
    public setNextElementIdToPlay(id: string, isUpdateAudioPlayerOn: boolean) {
        if (!this.nextElementIdToPlay || this.nextElementIdToPlay != id) {
            this.nextElementIdToPlay = id;

            if (isUpdateAudioPlayerOn) {
                this.updatePlayerStatus(); // May be redundant sometimes, but safer to trigger player update whenever the next element changes.
            }
        }
    }


    private updatePlayerStatus() {
        const player = this.getPlayer();
        if (!player) {
            return;
        }
        player.setAttribute(
            "src",
            this.currentAudioUrl(this.nextElementIdToPlay) +
                "?nocache=" +
                new Date().getTime()
        );
    }

    private currentAudioUrl(id: string): string {
        return this.urlPrefix + "/audio/" + id + ".mp3";
    }

    private getPlayer(): HTMLMediaElement {
        // REVIEW: Should we cache this? is it weird to have this event handler multiple times?

        return this.getAudio("bloom-audio-player", audio => {
            // if we just pass the function, it has the wrong "this"
            audio.addEventListener("ended", () => this.playEnded());
            audio.addEventListener("error", () => this.playEnded());
        });
    }

    public playEnded(): void {
        if (this.elementsToPlayConsecutivelyStack &&
            this.elementsToPlayConsecutivelyStack.length > 0) {

            const currentElement = this.elementsToPlayConsecutivelyStack.pop();
            const newStackCount = this.elementsToPlayConsecutivelyStack.length;
            if (newStackCount > 0) {
                // More items to play
                const nextElement = this.elementsToPlayConsecutivelyStack[
                    newStackCount - 1
                ];
                this.setCurrentAudioElementFrom(
                    currentElement,
                    nextElement,
                    true
                );
                this.playCurrentInternal();
                return;
            } else {
                // Nothing left to play
                this.elementsToPlayConsecutivelyStack = [];
                this.elementsToHighlightStack = [];
                this.endTimesInSecsStack = [];
            }

            this.removeAudioCurrent();
            if (this.PageNarrationComplete) {
                this.PageNarrationComplete.raise(this.playerPage);
            }

            return;
        }
    }

    private getAudio(id: string, init: (audio: HTMLAudioElement) => void) {
        let player: HTMLAudioElement | null = document.querySelector(
            "#" + id
        ) as HTMLAudioElement;
        if (player && !player.play) {
            player.remove();
            player = null;
        }
        if (!player) {
            player = document.createElement("audio") as HTMLAudioElement;
            player.setAttribute("id", id);
            document.body.appendChild(player);
            init(player);
        }
        return player as HTMLMediaElement;
    }

    public canPlayAudio(current: Element): boolean {
        return true; // currently no way to check
    }

    // Returns all elements that match CSS selector {expr} as an array.
    // Querying can optionally be restricted to {container}’s descendants
    // If includeSelf is true, it includes both itself as well as its descendants.
    // Otherwise, it only includes descendants.
    private findAll(
        expr: string,
        container: HTMLElement,
        includeSelf: boolean = false
    ): HTMLElement[] {
        // querySelectorAll checks all the descendants
        const allMatches: HTMLElement[] = [].slice.call(
            (container || document).querySelectorAll(expr)
        );

        // Now check itself
        if (includeSelf && container && container.matches(expr)) {
            allMatches.push(container);
        }

        return allMatches;
    }

    private getRecordableDivs(container: HTMLElement) {
        return this.findAll("div.bloom-editable.bloom-content1", container);
    }

    // Optional param is for use when 'playerPage' has NOT been initialized.
    // Not using the optional param assumes 'playerPage' has been initialized
    private getPageRecordableDivs(page?: HTMLElement): HTMLElement[] {
        return this.getRecordableDivs(page ? page : this.playerPage);
    }

    // Optional param is for use when 'playerPage' has NOT been initialized.
    // Not using the optional param assumes 'playerPage' has been initialized
    private getPageAudioElements(page?: HTMLElement): HTMLElement[] {
        return [].concat.apply(
            [],
            this.getPageRecordableDivs(page).map(x =>
                this.findAll(".audio-sentence", x, true)
            )
        );
    }

    public play() {
        if (!this.paused) {
            return; // no change.
        }
        // I'm not sure how getPlayer() can return null/undefined, but have seen it happen
        // typically when doing something odd like trying to go back from the first page.
        if (this.segments.length && this.getPlayer()) {
            this.getPlayer().play();
        }
        this.paused = false;
        // adjust startPlay by the elapsed pause. This will cause fakePageNarrationTimedOut to
        // start a new timeout if we are depending on it to fake PageNarrationComplete.
        const pause = new Date().getTime() - this.startPause.getTime();
        this.startPlay = new Date(this.startPlay.getTime() + pause);
        //console.log("paused for " + pause + " and adjusted start time to " + this.startPlay);
        if (this.fakeNarrationAborted) {
            // we already paused through the timeout for normal advance.
            // This call (now we are not paused and have adjusted startPlay)
            // will typically start a new timeout. If we are very close to
            // the desired duration it may just raise the event at once.
            // Either way we should get the event raised exactly once
            // at very close to the right time, allowing for pauses.
            this.fakeNarrationAborted = false;
            this.fakePageNarrationTimedOut(this.playerPage);
        }
    }

    public pause() {
        if (this.paused) {
            return;
        }
        if (this.segments.length && this.getPlayer()) {
            this.getPlayer().pause();
        }
        this.paused = true;
        this.startPause = new Date();
    }

    public computeDuration(page: HTMLElement): void {
        this.playerPage = page;
        this.segments = this.getPageAudioElements();
        this.PageDuration = 0.0;
        this.segmentIndex = -1; // so pre-increment in getNextSegment sets to 0.
        this.startPlay = new Date();
        //console.log("started play at " + this.startPlay);
        // in case we are already paused (but did manual advance), start computing
        // the pause duration from the beginning of this page.
        this.startPause = this.startPlay;
        if (this.segments.length === 0) {
            this.PageDuration = 3.0;
            if (this.PageDurationAvailable) {
                this.PageDurationAvailable.raise(page);
            }
            // Since there is nothing to play, we will never get an 'ended' event
            // from the player. If we are going to advance pages automatically,
            // we need to raise PageNarrationComplete some other way.
            // A timeout allows us to raise it after the arbitrary duration we have
            // selected. The tricky thing is to allow it to be paused.
            setTimeout(
                () => this.fakePageNarrationTimedOut(page),
                this.PageDuration * 1000
            );
            this.fakeNarrationAborted = false;
            return;
        }
        // trigger first duration evaluation. Each triggers another until we have them all.
        this.getNextSegment();
        //this.getDurationPlayer().setAttribute("src", this.currentAudioUrl(this.segments[0].getAttribute("id")));
    }

    private getNextSegment() {
        this.segmentIndex++;
        if (this.segmentIndex < this.segments.length) {
            const attrDuration = this.segments[this.segmentIndex].getAttribute(
                "data-duration"
            );
            if (attrDuration) {
                // precomputed duration available, use it and go on.
                this.PageDuration += parseFloat(attrDuration);
                this.getNextSegment();
                return;
            }
            // Replace this with the commented code to have ask the browser for duration.
            // (Also uncomment the getDurationPlayer method)
            // However, this doesn't work in apps.
            this.getNextSegment();
            // this.getDurationPlayer().setAttribute("src",
            //     this.currentAudioUrl(this.segments[this.segmentIndex].getAttribute("id")));
        } else {
            if (this.PageDuration < 3.0) {
                this.PageDuration = 3.0;
            }
            if (this.PageDurationAvailable) {
                this.PageDurationAvailable.raise(this.playerPage);
            }
        }
    }

    private fakePageNarrationTimedOut(page: HTMLElement) {
        if (this.paused) {
            this.fakeNarrationAborted = true;
            return;
        }
        // It's possible we experienced one or more pauses and therefore this timeout
        // happened too soon. In that case, this.startPlay will have been adjusted by
        // the pauses, so we can detect that here and start a new timeout which will
        // occur at the appropriately delayed time.
        const duration =
            (new Date().getTime() - this.startPlay.getTime()) / 1000;
        if (duration < this.PageDuration - 0.01) {
            // too soon; try again.
            setTimeout(
                () => this.fakePageNarrationTimedOut(page),
                (this.PageDuration - duration) * 1000
            );
            return;
        }
        if (this.PageNarrationComplete) {
            this.PageNarrationComplete.raise(page);
        }
    }
}
