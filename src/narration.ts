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
    private idOfCurrentSentence: string;
    private playingAll: boolean;
    private paused: boolean = false;
    public urlPrefix: string;
    // The time we started to play the current page (set in computeDuration, adjusted for pauses)
    private startPlay: Date;
    private startPause: Date;
    private fakeNarrationAborted: boolean = false;
    private segmentIndex: number;

    private segments: HTMLElement[];

    // The first one to play should be at the end for both of these
    private elementsToPlayConsecutivelyStack: HTMLElement[];
    private nextElementIdToPlay: string;
    private startTimesInSecsStack: number[];
    private elementsToHighlightStack: HTMLElement[];

    public PageNarrationComplete: LiteEvent<HTMLElement>;
    public PageDurationAvailable: LiteEvent<HTMLElement>;
    public PageDuration: number;

    constructor() {
        // Initialize them here to be safe
        this.elementsToHighlightStack = [];
        this.startTimesInSecsStack = [];
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

    private playNextSubElement() {
        // the item should not be popped off the stack until it's completely done with.
        const highlightCount = this.elementsToHighlightStack.length;
        const startTimesCount = this.startTimesInSecsStack.length;

        if (highlightCount <= 0 || startTimesCount <= 0) {
            return;
        }

        const element = this.elementsToHighlightStack[highlightCount -1];

        // TODO: No idea what value to pass in for disableHighlightIfNoAUdio.
        this.setCurrentAudioElement(element, false, false);  // TODO: can you figure out a way to specify the previous one?

        if (startTimesCount >= 2) {
            const nextStartTimeInSecs: number = this.startTimesInSecsStack[startTimesCount - 2];

            let currentTimeInSecs: number;
            const mediaPlayer = document.getElementById("bloom-audio-player");
            if (mediaPlayer) {
                // This should be more accurate
                currentTimeInSecs = (mediaPlayer as HTMLMediaElement).currentTime;

            } else {
                // TODO: Maybe you should re-structure it and pop sooner  since you really don't need this part of the code

                // A decent estimate if the more accurate method not available
                currentTimeInSecs = this.startTimesInSecsStack[startTimesCount - 1];
            }

            let durationInSecs = nextStartTimeInSecs - currentTimeInSecs;

            // Handle cases where the currentTime has already exceeded the nextStartTime
            //   (might happen if you're unlucky in the thread queue... or if in debugger, etc.)
            const minHighlightThreshold = 0.1;
            if (durationInSecs <= minHighlightThreshold) {
                durationInSecs = minHighlightThreshold;
            }

            setTimeout(() => {
                this.playSubElementEnded();
            }, durationInSecs * 1000);
        }
    }

    private playSubElementEnded() {
        if (this.startTimesInSecsStack.length < 2) {
            // length=0: obviously problematic.
            // length=1: Could theoretically do partial processing, but since it's the last one, just wait for end event to fire which will call playEnded()
            return;
        }

        const mediaPlayer: HTMLMediaElement = document.getElementById("bloom-audio-player")! as HTMLMediaElement;
        if (mediaPlayer.ended || mediaPlayer.error) {
            this.removeAudioCurrent();  // TODO: Not sure if desired.
            return;
        }
        const playedDuration: number | undefined | null = mediaPlayer.currentTime;

        // Check if the next one is actually ready to finish. (It might not if the audio got paused).
        const nextStartTime = this.startTimesInSecsStack[this.startTimesInSecsStack.length - 2];
        if (playedDuration && playedDuration < nextStartTime) {
            // Still need to wait. Abort early and check again later.
            const minimumRemainingDuration = nextStartTime - playedDuration;
            setTimeout(() => {
                this.playSubElementEnded();
            }, minimumRemainingDuration * 1000);

            return;
        }

        this.elementsToHighlightStack.pop();
        this.startTimesInSecsStack.pop();
        this.playNextSubElement();
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

                const timingsStr: string | null = element.getAttribute("data-audioRecordingTimings");
                if (timingsStr) {
                    const fields = timingsStr.split(" ");
                    this.startTimesInSecsStack = [];
                    for (let i = fields.length - 1; i >= 0; --i) {
                        this.startTimesInSecsStack.push(Number(fields[i]));
                    }
                    const childSpanElements = element.getElementsByTagName("span");

                    this.elementsToHighlightStack = [];
                    for (let i = childSpanElements.length - 1; i >= 0 ; --i) {
                        this.elementsToHighlightStack.push(childSpanElements.item(i)!);
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
        isUpdateAudioPlayerOn: boolean = true
    ): void {
        const firstExistingAudioCurrentElement: Element | null = this.playerPage.querySelector(".ui-audioCurrent");

        this.setCurrentAudioElementFrom(
            firstExistingAudioCurrentElement,
            elementToChangeTo,
            disableHighlightIfNoAudio,
            isUpdateAudioPlayerOn
        );
    }

    private setCurrentAudioElementFrom(
        currentElement: Element | null | undefined,
        elementToChangeTo: Element,
        disableHighlightIfNoAudio,  // TODO: Am i needed? Study BloomDesktop4.6 to find the answer
        isUpdateAudioPlayerOn: boolean = true
    ): void {
        if (currentElement == elementToChangeTo) {
            // No need to do much, and better not to so we can avoid any temporary flashes as the highlight is removed and re-applied
            // TODO: Maybe need to pass isUpdateAudioPlayerOn through here.
            this.setNextElementIdToPlay(elementToChangeTo.id, isUpdateAudioPlayerOn);
            return;
        }

        if (currentElement) {
            this.removeAudioCurrent();
        }

        elementToChangeTo.classList.add("ui-audioCurrent");

        this.setNextElementIdToPlay(elementToChangeTo.id, isUpdateAudioPlayerOn);
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
        // TODO: IDK, should we cache this? is it weird to have this event handler multiple times?

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
                this.startTimesInSecsStack = [];
                this.elementsToHighlightStack = [];
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
