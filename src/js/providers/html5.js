define([
    'utils/css',
    'utils/helpers',
    'utils/stretching',
    'utils/underscore',
    'events/events',
    'events/states',
    'utils/eventdispatcher',
    'providers/default',
    'utils/video'
], function(cssUtils, utils, stretchUtils, _, events, states, eventdispatcher, DefaultProvider, video) {

    var clearInterval = window.clearInterval,
        stallInterval,
        STALL_DELAY = 256,
        _isIE = utils.isMSIE(),
        _isMobile = utils.isMobile(),
        _isSafari = utils.isSafari(),
        _isAndroid = utils.isAndroidNative(),
        _isIOS7 = utils.isIOS(7),
        _name = 'html5';



    // Browsers, including latest chrome, do not always report Stalled events in a timely fashion
    var stallCheckGenerator = function(videotag, stalledHandler) {
        var lastChecked = -1;
        return function() {
            if (videotag.paused) { return; }
            if (videotag.currentTime === lastChecked) {
                stalledHandler();
            }
            lastChecked = videotag.currentTime;
        };
    };

    function _setupListeners(eventsHash, videoTag) {
        utils.foreach(eventsHash, function(evt, evtCallback) {
            videoTag.addEventListener(evt, evtCallback, false);
        });

        var checker = stallCheckGenerator(videoTag, eventsHash.stalled);
        stallInterval = setInterval(checker, STALL_DELAY);
    }

    function _removeListeners(eventsHash, videoTag) {
        utils.foreach(eventsHash, function(evt, evtCallback) {
            videoTag.removeEventListener(evt, evtCallback, false);
        });

        if (stallInterval) {
            clearInterval(stallInterval);
        }
    }

    function VideoProvider(_playerId, _playerConfig) {

        // Current media state
        this.state = states.IDLE;

        // Are we buffering due to seek, or due to playback?
        this.seeking = false;

        var _dispatcher = new eventdispatcher('provider.' + _name);
        _.extend(this, _dispatcher);

        var _this = this,
            _mediaEvents = {
                //abort: _generalHandler,
                click : _onClickHandler,
                durationchange: _durationUpdateHandler,
                //emptied: _generalHandler,
                ended: _endedHandler,
                error: _errorHandler,

                //play: _onPlayHandler, // play is attempted, but hasn't necessarily started
                //loadstart: _generalHandler,
                //loadeddata: _onLoadedData, // we have duration
                loadedmetadata: _onLoadedMetaData, // we have video dimensions
                canplay: _canPlayHandler,
                playing: _playingHandler,
                progress: _progressHandler, // status of video data download
                //canplaythrough: _generalHandler,

                //pause: _pauseHandler,
                //ratechange: _generalHandler,
                //readystatechange: _generalHandler,
                seeked: _sendSeekedEvent,
                //seeking: _seekingHandler,
                stalled: _stalledHandler,
                //suspend: _generalHandler,
                timeupdate: _timeUpdateHandler,
                volumechange: _volumeHandler,
                waiting: _stalledHandler,

                webkitbeginfullscreen: _fullscreenBeginHandler,
                webkitendfullscreen: _fullscreenEndHandler
            },
            // DOM container
            _container,
            // Currently playing source
            _source,
            // Current duration
            _duration,
            // Current position
            _position,
            // Whether seeking is ready yet
            _canSeek = false,
            // Whether we have sent out the BUFFER_FULL event
            _bufferFull,
            // If we should seek on canplay
            _delayedSeek = 0,
            // Using setInterval to check buffered ranges
            _bufferInterval = -1,
            // Last sent buffer amount
            _bufferPercent = -1,
            // Whether or not we're listening to video tag events
            _attached = false,
            // Quality levels
            _levels,
            // Current quality level index
            _currentQuality = -1,

            // post roll support
            _beforecompleted = false,

            _fullscreenState = false;

        // Overwrite the event dispatchers to block on certain occasions
        this.sendEvent = function() {
            if (!_attached) { return; }

            _dispatcher.sendEvent.apply(this, arguments);
        };


        // Find video tag, or create it if it doesn't exist.  View may not be built yet.
        var element = document.getElementById(_playerId);
        var _videotag = (element) ? element.querySelector('video') : undefined;
        _videotag = _videotag || document.createElement('video');

        _setupListeners(_mediaEvents, _videotag);


        // Workaround for a Safari bug where video disappears on switch to fullscreen
        if (!_isIOS7) {
            _videotag.controls = true;
            _videotag.controls = false;
        }

        // Enable AirPlay
        _videotag.setAttribute('x-webkit-airplay', 'allow');
        _videotag.setAttribute('webkit-playsinline', '');


        _attached = true;

        function _onClickHandler() {
            _this.sendEvent(events.JWPLAYER_PROVIDER_CLICK);
        }

        function _durationUpdateHandler() {
            if (!_attached) { return; }
            var newDuration = _videotag.duration;
            if (_duration !== newDuration) {
                _duration = newDuration;
            }
            if (_isAndroid && _delayedSeek > 0 && newDuration > _delayedSeek) {
                _this.seek(_delayedSeek);
            }
            _timeUpdateHandler();
        }

        function _timeUpdateHandler(evt) {
            _progressHandler(evt);

            if (!_attached) { return; }

            if (_this.state === states.PLAYING) {
                _position = _videotag.currentTime;
                // do not allow _durationUpdateHandler to update _canSeek before _canPlayHandler does
                if (evt) {
                    _canSeek = true;
                }
                _this.sendEvent(events.JWPLAYER_MEDIA_TIME, {
                    position: _position,
                    duration: _duration
                });
                // Working around a Galaxy Tab bug; otherwise _duration should be > 0
                //              if (_position >= _duration && _duration > 3 && !utils.isAndroid(2.3)) {
                //                  _complete();
                //              }
            }


            if (_this.state === states.STALLED) {
                _this.setState(states.PLAYING);
            }
        }

        function sendMetaEvent() {
            _this.sendEvent(events.JWPLAYER_MEDIA_META, {
                duration: _videotag.duration,
                height: _videotag.videoHeight,
                width: _videotag.videoWidth
            });
        }

        function _canPlayHandler() {
            if (!_attached) {
                return;
            }

            if (!_canSeek) {
                _canSeek = true;
                _sendBufferFull();
            }
        }

        function _onLoadedMetaData() {
            if (!_attached) {
                return;
            }

            _canPlayHandler();

            //fixes Chrome bug where it doesn't like being muted before video is loaded
            if (_videotag.muted) {
                _videotag.muted = false;
                _videotag.muted = true;
            }
            sendMetaEvent();
        }

        function _progressHandler() {
            if (_canSeek && _delayedSeek > 0 && !_isAndroid) {
                // Need to set a brief timeout before executing delayed seek; IE9 stalls otherwise.
                if (_isIE) {
                    setTimeout(function() {
                        if (_delayedSeek > 0) {
                            _this.seek(_delayedSeek);
                        }
                    }, 200);
                } else {
                    // Otherwise call it immediately
                    _this.seek(_delayedSeek);
                }
            }
        }

        function _sendBufferFull() {
            if (!_bufferFull) {
                _bufferFull = true;
                _this.sendEvent(events.JWPLAYER_MEDIA_BUFFER_FULL);
            }
        }

        function _playingHandler() {
            if (!_attached) {
                return;
            }

            _this.setState(states.PLAYING);
            _this.sendEvent(events.JWPLAYER_PROVIDER_FIRST_FRAME, {});
        }

        function _stalledHandler() {
            if (!_attached) {
                return;
            }

            // A stall after loading, should just stay loading
            if (_this.state === states.LOADING) {
                return;
            }

            // During seek we stay in paused state
            if (_this.seeking) {
                return;
            }

            _this.setState(states.STALLED);
        }

        function _errorHandler() { //evt) {
            if (!_attached) {
                return;
            }
            utils.log('Error playing media: %o %s', _videotag.error, _videotag.src || _source.file);
            _this.sendEvent(events.JWPLAYER_MEDIA_ERROR, {
                message: 'Error loading media: File could not be played'
            });
            _this.setState(states.IDLE);
        }

        function _getPublicLevels(levels) {
            var publicLevels;
            if (utils.typeOf(levels) === 'array' && levels.length > 0) {
                publicLevels = [];
                for (var i = 0; i < levels.length; i++) {
                    var level = levels[i],
                        publicLevel = {};
                    publicLevel.label = _levelLabel(level) ? _levelLabel(level) : i;
                    publicLevels[i] = publicLevel;
                }
            }
            return publicLevels;
        }

        function _setLevels(levels) {
            _levels = levels;
            _currentQuality = _pickInitialQuality(levels);
            var publicLevels = _getPublicLevels(levels);
            if (publicLevels) {
                //_sendEvent?
                _this.sendEvent(events.JWPLAYER_MEDIA_LEVELS, {
                    levels: publicLevels,
                    currentQuality: _currentQuality
                });
            }
        }

        function _levelLabel(level) {
            if (level.label) {
                return level.label;
            }

            return 0;
        }

        function _pickInitialQuality(levels) {
            var currentQuality = Math.max(0, _currentQuality);
            var label = _playerConfig.qualityLabel;
            if (levels) {
                for (var i = 0; i < levels.length; i++) {
                    if (levels[i]['default']) {
                        currentQuality = i;
                    }
                    if (label && levels[i].label === label) {
                        return i;
                    }
                }
            }
            return currentQuality;
        }

        function _forceVideoLoad() {
            // These browsers will not replay videos without reloading them
            return (_isMobile || _isSafari);
        }

        function _completeLoad(startTime, duration) {

            _source = _levels[_currentQuality];

            clearInterval(_bufferInterval);
            _bufferInterval = setInterval(_sendBufferUpdate, 100);

            _delayedSeek = 0;

            var sourceChanged = (_videotag.src !== _source.file);
            if (sourceChanged || _forceVideoLoad()) {
                if (!_isMobile) {
                    // don't change state on mobile because a touch event may be required to start playback
                    _this.setState(states.LOADING);
                }
                _canSeek = false;
                _bufferFull = false;
                _duration = duration ? duration : -1;
                _videotag.src = _source.file;
                _videotag.load();
            } else {
                // Load event is from the same video as before
                if (startTime === 0) {
                    // restart video without dispatching seek event
                    _delayedSeek = -1;
                    _this.seek(startTime);
                }
                // meta event is usually triggered by load, and is needed for googima to work on replay
                sendMetaEvent();
                _videotag.play();
            }

            _position = _videotag.currentTime;

            if (_isMobile) {
                // results in html5.controller calling video.play()
                _sendBufferFull();
            }

            //in ios and fullscreen, set controls true, then when it goes to normal screen the controls don't show'
            if (utils.isIOS() && _this.getFullScreen()) {
                _videotag.controls = true;
            }

            if (startTime > 0) {
                _this.seek(startTime);
            }
        }

        this.stop = function() {
            if (!_attached) { return; }
            clearInterval(_bufferInterval);
            _videotag.removeAttribute('src');
            if (!_isIE) {
                _videotag.load();
            }
            _currentQuality = -1;
            this.setState(states.IDLE);
        };


        this.destroy = function() {
             _removeListeners(_mediaEvents, _videotag);

            this.remove();
        };

        this.load = function(item) {
            if (!_attached) {
                return;
            }

            _setLevels(item.sources);

            _completeLoad(item.starttime || 0, item.duration);
        };

        this.play = function() {
            if (_attached) {
                if (_this.seeking) {
                    _this.setState(states.LOADING);
                    _this.once(events.JWPLAYER_MEDIA_SEEKED, _this.play);
                    return;
                }
                _videotag.play();
            }
        };

        this.pause = function() {
            if (_attached) {
                _videotag.pause();
                this.setState(states.PAUSED);
            }
        };

        this.seek = function(seekPos) {
            if (!_attached) {
                return;
            }

            if (_delayedSeek === 0) {
                this.sendEvent(events.JWPLAYER_MEDIA_SEEK, {
                    position: _videotag.currentTime,
                    offset: seekPos
                });
            }

            if (_canSeek) {
                _delayedSeek = 0;
                // handle readystate issue
                var status = utils.tryCatch(function() {
                    _this.seeking = true;
                    _videotag.currentTime = seekPos;
                });
                if (status instanceof utils.Error) {
                    _delayedSeek = seekPos;
                }
            } else {
                _delayedSeek = seekPos;
            }
        };

        function _sendSeekedEvent() {
            _this.seeking = false;
            _this.sendEvent(events.JWPLAYER_MEDIA_SEEKED);
        }

        this.volume = function(vol) {
            _videotag.volume = Math.min(Math.max(0, vol / 100), 1);
        };

        function _volumeHandler() {
            _this.sendEvent('volume', {
                volume: Math.round(_videotag.volume * 100)
            });
            _this.sendEvent('mute', {
                mute: _videotag.muted
            });
        }

        this.mute = function(state) {
            _videotag.muted = !!state;
        };

        function _sendBufferUpdate() {
            if (!_attached) { return; }
            var newBuffer = _getBuffer();

            if (newBuffer >= 1) {
                clearInterval(_bufferInterval);
            }

            if (newBuffer !== _bufferPercent) {
                _bufferPercent = newBuffer;
                _this.sendEvent(events.JWPLAYER_MEDIA_BUFFER, {
                    bufferPercent: Math.round(_bufferPercent * 100)
                });
            }
        }

        function _getBuffer() {
            var buffered = _videotag.buffered;
            if (!buffered || !_videotag.duration || buffered.length === 0) {
                return 0;
            }
            return buffered.end(buffered.length-1) / _videotag.duration;
        }

        function _endedHandler() {
            if (_attached) {
                if (_this.state !== states.IDLE && _this.state !== states.COMPLETE) {
                    clearInterval(_bufferInterval);
                    _currentQuality = -1;
                    _beforecompleted = true;

                    _this.sendEvent(events.JWPLAYER_MEDIA_BEFORECOMPLETE);
                    // This event may trigger the detaching of the player
                    //  In that case, playback isn't complete until the player is re-attached
                    if (!_attached) {
                        return;
                    }

                    _playbackComplete();
                }
            }
        }

        function _playbackComplete() {
            _this.setState(states.COMPLETE);
            _beforecompleted = false;
            _this.sendEvent(events.JWPLAYER_MEDIA_COMPLETE);
        }

        function _fullscreenBeginHandler(e) {
            _fullscreenState = true;
            _sendFullscreen(e);
            // show controls on begin fullscreen so that they are disabled properly at end
            if (utils.isIOS()) {
                _videotag.controls = false;
            }
        }

        function _fullscreenEndHandler(e) {
            _fullscreenState = false;
            _sendFullscreen(e);
            if (utils.isIOS()) {
                _videotag.controls = false;
            }
        }

        function _sendFullscreen(e) {
            _this.sendEvent('fullscreenchange', {
                target: e.target,
                jwstate: _fullscreenState
            });
        }

        this.checkComplete = function() {
            return _beforecompleted;
        };

        /**
         * Return the video tag and stop listening to events
         */
        this.detachMedia = function() {
            clearInterval(_bufferInterval);
            _attached = false;
            // _canSeek = false;
            return _videotag;
        };

        /**
         * Begin listening to events again
         */
        this.attachMedia = function(seekable) {
            _attached = true;
            if (!seekable) {
                _canSeek = false;
            }

            // This is after a postroll completes
            if (_beforecompleted) {
                _playbackComplete();
            }
        };

        this.setContainer = function(element) {
            _container = element;
            element.appendChild(_videotag);
        };

        this.getContainer = function() {
            return _container;
        };

        this.remove = function() {
            // stop video silently
            if (_videotag) {
                _videotag.removeAttribute('src');
                if (!_isIE) {
                    _videotag.load();
                }
            }

            clearInterval(_bufferInterval);

            _currentQuality = -1;

            // remove
            if (_container === _videotag.parentNode) {
                _container.removeChild(_videotag);
            }
        };

        this.setVisibility = function(state) {
            state = !!state;
            if (state || _isAndroid) {
                // Changing visibility to hidden on Android < 4.2 causes 
                // the pause event to be fired. This causes audio files to 
                // become unplayable. Hence the video tag is always kept 
                // visible on Android devices.
                cssUtils.style(_container, {
                    visibility: 'visible',
                    opacity: 1
                });
            } else {
                cssUtils.style(_container, {
                    visibility: '',
                    opacity: 0
                });
            }
        };

        this.resize = function(width, height, stretching) {
            return stretchUtils.stretch(stretching,
                _videotag,
                width, height,
                _videotag.videoWidth, _videotag.videoHeight);
        };

        this.setControls = function(state) {
            _videotag.controls = !!state;
        };

        this.supportsFullscreen = _.constant(true);

        this.setFullScreen = function(state) {
            state = !!state;

            // This implementation is for iOS and Android WebKit only
            // This won't get called if the player contain can go fullscreen
            if (state) {
                var status = utils.tryCatch(function() {
                    var enterFullscreen =
                        _videotag.webkitEnterFullscreen ||
                        _videotag.webkitEnterFullScreen;
                    if (enterFullscreen) {
                        enterFullscreen.apply(_videotag);
                    }

                });

                if (status instanceof utils.Error) {
                    //object can't go fullscreen
                    return false;
                }

                return _this.getFullScreen();

            } else {
                var exitFullscreen =
                    _videotag.webkitExitFullscreen ||
                    _videotag.webkitExitFullScreen;
                if (exitFullscreen) {
                    exitFullscreen.apply(_videotag);
                }
            }

            return state;
        };

        _this.getFullScreen = function() {
            return _fullscreenState || !!_videotag.webkitDisplayingFullscreen;
        };

        this.isAudioFile = function() {
            if (!_levels) {
                return false;
            }
            var type = _levels[0].type;
            return (type === 'oga' || type === 'aac' || type === 'mp3' || type === 'vorbis');
        };

        this.setCurrentQuality = function(quality) {
            if (_currentQuality === quality) {
                return;
            }
            quality = parseInt(quality, 10);
            if (quality >= 0) {
                if (_levels && _levels.length > quality) {
                    _currentQuality = quality;
                    this.sendEvent(events.JWPLAYER_MEDIA_LEVEL_CHANGED, {
                        currentQuality: quality,
                        levels: _getPublicLevels(_levels)
                    });
                    var time = _videotag.currentTime;
                    var duration = _videotag.duration;
                    if (duration <= 0) {
                        duration = _duration;
                    }
                    _completeLoad(time, duration);
                }
            }
        };

        this.getCurrentQuality = function() {
            return _currentQuality;
        };

        this.getQualityLevels = function() {
            return _getPublicLevels(_levels);
        };

        this.getName = function() {
            return { name : _name };
        };
    }

    var MimeTypes = {
        'aac': 'audio/mp4',
        'mp4': 'video/mp4',
        'f4v': 'video/mp4',
        'm4v': 'video/mp4',
        'mov': 'video/mp4',
        //'m4a': 'audio/x-m4a', // converted to aac by source.js
        'mp3': 'audio/mpeg',
        'ogv': 'video/ogg',
        'ogg': 'video/ogg',
        'oga': 'video/ogg',
        'vorbis': 'video/ogg',
        'webm': 'video/webm',

        // The following are not expected to work in Chrome
        'f4a': 'video/aac',
        'm3u8': 'application/vnd.apple.mpegurl',
        'm3u': 'application/vnd.apple.mpegurl',
        'hls': 'application/vnd.apple.mpegurl'
    };


    // Register provider
    var F = function(){};
    F.prototype = DefaultProvider;
    VideoProvider.prototype = new F();
    VideoProvider.supports = function(source) {

        var file = source.file;
        var type = source.type;

        // HLS not sufficiently supported on Android devices; should fail over automatically.
        if (type === 'hls') {
            //when androidhls is set to true, allow HLS playback on Android 4.1 and up
            if (source.androidhls) {
                var isAndroidNative = utils.isAndroidNative;
                if (isAndroidNative(2) || isAndroidNative(3) || isAndroidNative('4.0')) {
                    return false;
                } else if (utils.isAndroid()) { //utils.isAndroidNative()) {
                    // skip canPlayType check
                    // canPlayType returns '' in native browser even though HLS will play
                    return true;
                }
            } else if (utils.isAndroid()) {
                return false;
            }
        }

        // Ensure RTMP files are not seen as videos
        if (utils.isRtmp(file, type)) {
            return false;
        }

        // Not OK to use HTML5 with no extension
        if (!MimeTypes[type]) {
            return false;
        }

        // Last, but not least, we ask the browser
        // (But only if it's a video with an extension known to work in HTML5)
        if (video.canPlayType) {
            var result = video.canPlayType(MimeTypes[type]);
            return !!result;
        }
        return false;
    };

    return VideoProvider;

});
