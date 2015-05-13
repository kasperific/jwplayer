define([
    'utils/helpers',
    'events/events',
    'utils/backbone.events',
    'events/states',
    'cast/display',
    'view/captionsrenderer',
    'view/display',
    'view/displayicon',
    'view/dock',
    'view/logo',
    'view/controlbar',
    'view/preview',
    'view/rightclick',
    'view/title',
    'utils/css',
    'utils/underscore',
    'handlebars-loader!templates/player.html'
], function(utils, events, Events, states, CastDisplay,
            CaptionsRenderer, Display, DisplayIcon, Dock, Logo,
            Controlbar, Preview, RightClick, Title, cssUtils, _, playerTemplate) {

    var _styles = utils.style,
        _bounds = utils.bounds,
        _isMobile = utils.isMobile(),
        _isIPad = utils.isIPad(),
        _isIPod = utils.isIPod(),
        DOCUMENT_FULLSCREEN_EVENTS = [
            'fullscreenchange',
            'webkitfullscreenchange',
            'mozfullscreenchange',
            'MSFullscreenChange'
        ],

        /*************************************************************
         * Player stylesheets - done once on script initialization;  *
         * These CSS rules are used for all JW Player instances      *
         *************************************************************/
        JW_CSS_BLOCK = 'block';

    var View = function(_api, _model) {
        var _playerElement,
            _container,
            _controlsLayer,
            _controlsTimeout = -1,
            _timeoutDuration = _isMobile ? 4000 : 2000,
            _videoLayer,
            _aspectRatioContainer,
            _lastWidth,
            _lastHeight,
            _instreamModel,
            _instreamMode = false,
            _controlbar,
            _preview,
            _display,
            _castDisplay,
            _dock,
            _logo,
            _title,
            _captionsRenderer,
            _audioMode,
            _errorState = false,
            _showing = false,
            _replayState,
            _rightClickMenu,
            _resizeMediaTimeout = -1,
            _inCB = false, // in control bar
            _currentState,
            _originalContainer,

            // view fullscreen methods and ability
            _requestFullscreen,
            _exitFullscreen,
            _elementSupportsFullscreen = false,

            // Used to differentiate tab focus events from click events, because when
            //  it is a click, the mouseDown event will occur immediately prior
            _focusFromClick = false,

            _this = _.extend(this, Events);

        _playerElement = utils.createElement(playerTemplate({id: _model.get('id')}));

        var width = _model.get('width'),
            height = _model.get('height');

        _styles(_playerElement, {
            width: width.toString().indexOf('%') > 0 ? width : (width+ 'px'),
            height: height.toString().indexOf('%') > 0 ? height : (height + 'px')
        });

        _requestFullscreen =
            _playerElement.requestFullscreen ||
            _playerElement.webkitRequestFullscreen ||
            _playerElement.webkitRequestFullScreen ||
            _playerElement.mozRequestFullScreen ||
            _playerElement.msRequestFullscreen;
        _exitFullscreen =
            document.exitFullscreen ||
            document.webkitExitFullscreen ||
            document.webkitCancelFullScreen ||
            document.mozCancelFullScreen ||
            document.msExitFullscreen;
        _elementSupportsFullscreen = _requestFullscreen && _exitFullscreen;

        function adjustSeek(amount) {
            var newSeek = utils.between(_model.get('position') + amount, 0, this.getDuration());
            this.seek(newSeek);
        }

        function adjustVolume(amount) {
            var newVol = utils.between(this.getVolume() + amount, 0, 100);
            this.setVolume(newVol);
        }

        function allowKeyHandling(evt) {
            // If Meta keys return
            if (evt.ctrlKey || evt.metaKey) {
                return false;
            }

            // Controls may be disabled during share screens, or via API
            if (!_model.get('controls')) {
                return false;
            }
            return true;
        }

        function handleKeydown(evt) {
            if (!allowKeyHandling(evt)) {
                // Let event bubble upwards
                return true;
            }

            // On keypress show the controlbar for a few seconds
            if (!_instreamMode) {
                _showControlbar();
                _resetTapTimer();
            }

            switch (evt.keyCode) {
                case 27: // Esc
                    _api.setFullscreen(false);
                    break;
                case 13: // enter
                case 32: // space
                    _api.play();
                    break;
                case 37: // left-arrow, if not adMode
                    if (!_instreamMode) {
                        adjustSeek.call(_api, -5);
                    }
                    break;
                case 39: // right-arrow, if not adMode
                    if (!_instreamMode) {
                        adjustSeek.call(_api, 5);
                    }
                    break;
                case 38: // up-arrow
                    adjustVolume.call(_api, 10);
                    break;
                case 40: // down-arrow
                    adjustVolume.call(_api, -10);
                    break;
                case 77: // m-key
                    _api.setMute();
                    break;
                case 70: // f-key
                    _api.setFullscreen();
                    break;
                default:
                    if (evt.keyCode >= 48 && evt.keyCode <= 59) {
                        // if 0-9 number key, move to n/10 of the percentage of the video
                        var number = evt.keyCode - 48;
                        var newSeek = (number / 10) * _api.getDuration();
                        _api.seek(newSeek);
                    }
                    break;
            }

            if (/13|32|37|38|39|40/.test(evt.keyCode)) {
                // Prevent keypresses from scrolling the screen
                evt.preventDefault();
                return false;
            }
        }

        function handleMouseDown() {
            _focusFromClick = true;

            // After a click it no longer has 'tab-focus'
            _this.trigger(events.JWPLAYER_VIEW_TAB_FOCUS, {
                hasFocus: false
            });
        }

        function handleFocus() {
            var wasTabEvent = !_focusFromClick;
            _focusFromClick = false;

            if (wasTabEvent) {
                _this.trigger(events.JWPLAYER_VIEW_TAB_FOCUS, {
                    hasFocus: true
                });
            }

            // On tab-focus, show the control bar for a few seconds
            if (!_instreamMode) {
                _showControlbar();
                _resetTapTimer();
            }
        }

        function handleBlur() {
            _focusFromClick = false;
            _this.trigger(events.JWPLAYER_VIEW_TAB_FOCUS, {
                hasFocus: false
            });
        }

        function _responsiveListener() {
            var bounds = _bounds(_playerElement),
                containerWidth = Math.round(bounds.width),
                containerHeight = Math.round(bounds.height);
            if (!document.body.contains(_playerElement)) {
                window.removeEventListener('resize', _responsiveListener);
                if (_isMobile) {
                    window.removeEventListener('orientationchange', _responsiveListener);
                }
            } else if (containerWidth && containerHeight) {
                if (containerWidth !== _lastWidth || containerHeight !== _lastHeight) {
                    _lastWidth = containerWidth;
                    _lastHeight = containerHeight;
                    clearTimeout(_resizeMediaTimeout);
                    _resizeMediaTimeout = setTimeout(_resizeMedia, 50);
                    _this.trigger(events.JWPLAYER_RESIZE, {
                        width: containerWidth,
                        height: containerHeight
                    });
                }
            }
            return bounds;
        }


        this.onChangeSkin = function(model, newSkin, oldSkin) {
            if (oldSkin) {
                utils.removeClass(_playerElement, 'jw-skin-'+oldSkin);
            }
            if (newSkin) {
                utils.addClass(_playerElement, 'jw-skin-'+newSkin);
            }
        };


        this.handleColorOverrides = function() {
            var id = _model.get('id');
            function addStyle(attr, elements, color) {
                if (!color) { return; }

                elements = utils.prefix(elements, '#' + id + ' ');

                var o = {};
                o[attr] = color;
                cssUtils.css(elements.join(', '), o);
            }

            var icons = [
                '.jw-icon',
                '.jw-text'
            ];

            var cues = [
                '.jw-cue:after',
                '.jw-thumb:after'
            ];

            var iconHovers = ['.jw-icon:hover'];
            var sliders = ['.jw-progress'];
            var containers = ['.jw-container'];

            addStyle('color', iconHovers, _model.get('skinColorActive'));
            addStyle('color', icons, _model.get('skinColorInactive'));
            addStyle('background', cues, _model.get('skinColorInactive'));
            addStyle('background', sliders, _model.get('skinColorActive'));
            addStyle('background', containers, _model.get('skinColorBackground'));
        };

        this.setup = function() {
            if (_errorState) {
                return;
            }

            this.handleColorOverrides();

            // Hide control elements until skin is loaded
            if (_model.get('skin-loading') === true) {
                utils.addClass(_playerElement, 'jw-flag-skin-loading');
                _model.once('change:skin-loading', function() {
                    utils.removeClass(_playerElement, 'jw-flag-skin-loading');
                });
            }

            this.onChangeSkin(_model, _model.get('skin'), '');
            _model.on('change:skin', this.onChangeSkin, this);

            _container = _playerElement;
            _videoLayer = _playerElement.getElementsByClassName('jw-media')[0];

            _controlsLayer = _playerElement.getElementsByClassName('jw-controls')[0];
            _aspectRatioContainer = _playerElement.getElementsByClassName('jw-aspect')[0];

            var previewElem = _playerElement.getElementsByClassName('jw-preview')[0];
            _preview = new Preview(_model);
            _preview.setup(previewElem);

            if (! _model.get('hidetitle')) {
                var _titleElement = _playerElement.getElementsByClassName('jw-title')[0];
                _title = new Title(_model);
                _title.setup(_titleElement);
            }

            _setupControls();

            // adds video tag to video layer
            _model.getVideo().setContainer(_videoLayer);

            // Native fullscreen (coming through from the provider)
            _model.mediaController.on('fullscreenchange', _fullscreenChangeHandler);
            // DOM fullscreen
            for (var i = DOCUMENT_FULLSCREEN_EVENTS.length; i--;) {
                document.addEventListener(DOCUMENT_FULLSCREEN_EVENTS[i], _fullscreenChangeHandler, false);
            }

            window.removeEventListener('resize', _responsiveListener);
            window.addEventListener('resize', _responsiveListener, false);
            if (_isMobile) {
                window.removeEventListener('orientationchange', _responsiveListener);
                window.addEventListener('orientationchange', _responsiveListener, false);
            }
            // So VAST will be in correct state when ad errors out from unknown filetype
            _api.onAdError(function() {
                utils.removeClass(_playerElement, 'jw-flag-ads');
            });

            _model.on('change:controls', _onChangeControls);

            _model.on('change:state', _stateHandler);
            _model.mediaController.on(events.JWPLAYER_MEDIA_ERROR, _errorHandler);
            _api.onPlaylistComplete(_playlistCompleteHandler);
            _api.onPlaylistItem(_playlistItemHandler);

            _model.on('change:castAvailable', function(model, val) {
                utils.toggleClass(_controlsLayer, 'jw-cast-available', val);
            });

            // set initial state
            if(_model.get('stretching')){
                _onStretchChange(_model, _model.get('stretching'));
            }
            // watch for changes
            _model.on('change:stretching', _onStretchChange);

            _model.on('change:castState', function(evt) {
                if (!_castDisplay) {
                    _castDisplay = new CastDisplay(_model.get('id'));
                    _castDisplay.statusDelegate = function(model, state) {
                        _castDisplay.setState(state);
                    };
                }
                if (evt.active) {
                    //utils.addClass(_captions, 'jw-captions-disabled');
                    _castDisplay.setState('connecting').setName(evt.deviceName).show();

                    _model.on('change:state', _castDisplay.statusDelegate);
                    _model.mediaController.on(events.JWPLAYER_CAST_AD_CHANGED, _castAdChanged);
                } else {
                    _model.off('change:state', _castDisplay.statusDelegate);
                    _model.mediaController.off(events.JWPLAYER_CAST_AD_CHANGED, _castAdChanged);

                    _castDisplay.hide();
                    if (!_instreamMode) {
                        _castAdsEnded();
                    }
                    //utils.removeClass(_captions, 'jw-captions-disable');
                    // redraw displayicon
                    _stateHandler(null, _model.get('state'));
                    _responsiveListener();
                }

            });

            _stateHandler(null, states.IDLE);

            if (!_isMobile) {
                _controlsLayer.addEventListener('mouseout', _mouseoutHandler, false);

                _controlsLayer.addEventListener('mousemove', _startFade, false);
                if (utils.isMSIE()) {
                    // Not sure why this is needed
                    _videoLayer.addEventListener('mousemove', _startFade, false);
                    _videoLayer.addEventListener('click', _display.clickHandler);
                }
            }
            _componentFadeListeners(_controlbar);
            _componentFadeListeners(_logo);

            if (_model.get('aspectratio')) {
                utils.addClass(_playerElement, 'jw-flag-aspect-mode');
                utils.style(_aspectRatioContainer, { 'padding-top': _model.get('aspectratio') });
            }

            setTimeout(function() {
                _resize(_model.get('width'), _model.get('height'));
            }, 0);
        };

        function _onStretchChange (model, newVal, oldVal) {
            if(oldVal){
                utils.removeClass(_playerElement, 'jw-stretch-' + oldVal);
            }
            utils.addClass(_playerElement, 'jw-stretch-' + newVal);
        }

        function _componentFadeListeners(comp) {
            if (comp) {
                comp.element().addEventListener('mousemove', _cancelFade, false);
                comp.element().addEventListener('mouseout', _resumeFade, false);
            }
        }

        function _mouseoutHandler() {
            clearTimeout(_controlsTimeout);
            _controlsTimeout = setTimeout(_hideControls, _timeoutDuration);
        }

        function _touchHandler() {
            if (_isMobile) {
                if (_showing) {
                    _hideControls();
                } else {
                    _showControls();
                }
            }
            if (_showing) {
                _resetTapTimer();
            }
        }

        function _resetTapTimer() {
            clearTimeout(_controlsTimeout);
            _controlsTimeout = setTimeout(_hideControls, _timeoutDuration);
        }

        function _startFade() {
            clearTimeout(_controlsTimeout);
            var model = _instreamMode ? _instreamModel : _model;
            var state = model.get('state');

            // We need _instreamMode because the state is IDLE during pre-rolls
            if (state === states.PLAYING || state === states.PAUSED || state === states.BUFFERING || _instreamMode) {
                _showControls();
                if (!_inCB) {
                    _controlsTimeout = setTimeout(_hideControls, _timeoutDuration);
                }
            }
        }

        function _logoClickHandler(evt){
            if (!evt.showing || !evt.link) {
                //_togglePlay();
                _api.play();
            }

            if (evt.showing && evt.link) {
                _api.pause(true);
                _api.setFullscreen(false);
                window.open(evt.link, evt.linktarget);
            }
        }

        // Over controlbar don't fade
        function _cancelFade() {
            clearTimeout(_controlsTimeout);
            _inCB = true;
        }

        function _resumeFade() {
            _inCB = false;
        }

        function forward(evt) {
            _this.trigger(evt.type, evt);
        }

        var toggleControls = function() {
            if (_model.get('controls')) {
                utils.removeClass(_controlsLayer, 'jw-controls-disabled');
            } else {
                utils.addClass(_controlsLayer, 'jw-controls-disabled');
            }
        };

        function _setupControls() {
            toggleControls();
            _model.on('change:controls', toggleControls);

            _display = new Display(_model);
            _display.on('click', function() {
                forward({type : events.JWPLAYER_DISPLAY_CLICK});
                _touchHandler();
                _api.play();
            });
            _display.on('doubleClick', function() {
                _api.setFullscreen();
            });
            _controlsLayer.appendChild(_display.element());

            var displayIcon = new DisplayIcon(_model);
            //toggle playback
            displayIcon.on('click', _api.play);
            _controlsLayer.appendChild(displayIcon.element());

            _dock = new Dock(_model);

            _logo = new Logo(_model);
            _logo.on(events.JWPLAYER_LOGO_CLICK, _logoClickHandler);

            var rightside = document.createElement('div');
            rightside.className = 'jw-controls-right';
            if (_model.get('config').logo) {
                rightside.appendChild(_logo.element());
            }
            rightside.appendChild(_dock.element());
            _controlsLayer.appendChild(rightside);

            // captions rendering
            _captionsRenderer = new CaptionsRenderer(_model);
            _captionsRenderer.setup(_model.get('config').captions);

            // captions should be place behind controls, and not hidden when controls are hidden
            _controlsLayer.parentNode.insertBefore(_captionsRenderer.element(), _title.element());


            if (!_isMobile) {
                _rightClickMenu = new RightClick();
                _rightClickMenu.setup(_model, _playerElement, _playerElement);
            }

            _controlbar = new Controlbar(_api, _model);
            _controlbar.on(events.JWPLAYER_USER_ACTION, _resetTapTimer);
            _model.on('change:scrubbing', _dragging);

            _controlsLayer.appendChild(_controlbar.element());

            if (_isIPod) {
                _hideControlbar();
            }
            if (utils.canCast()) {
                _this.forceControls(true);
            }

            _playerElement.onmousedown = handleMouseDown;
            _playerElement.onfocusin = handleFocus;
            _playerElement.addEventListener('focus', handleFocus);
            _playerElement.onfocusout = handleBlur;
            _playerElement.addEventListener('blur', handleBlur);
            _playerElement.addEventListener('keydown', handleKeydown);
        }

        function _onChangeControls(model, bool) {
            if (!bool) {
                _hideControls();
            }
            else {
                // model may be instream or normal depending on who triggers this
                _stateHandler(model, model.get('state'));
            }
        }

        function stopDragging(model) {
            if (model.get('state') === states.PAUSED) {
                model.once('change:state', stopDragging);
                return;
            }

            // Handle the case where they begin seeking again before the last seek completes
            if (model.get('scrubbing') === false) {
                utils.removeClass(_playerElement, 'jw-flag-dragging');
            }
        }

        function _dragging(model, val) {
            model.off('change:state', stopDragging);

            if (val) {
                utils.addClass(_playerElement, 'jw-flag-dragging');
            } else {
                stopDragging(model);
            }
        }

        function _castAdChanged(evt) {
            // end ad mode (ad provider removed)
            if (evt.done) {
                _castAdsEnded();
                return;
            }

            if (!evt.complete) {
                // start ad mode
                if (!_instreamMode) {
                    _castAdsStarted();
                }

                this.setAltText(evt.message);

                // clickthrough callback
                var clickAd = evt.onClick;
                if (clickAd !== undefined) {
                    _display.setAlternateClickHandler(function() {
                        clickAd(evt);
                    });
                }
                //skipAd callback
                var skipAd = evt.onSkipAd;
                if (skipAd !== undefined && _castDisplay) {
                    _castDisplay.setSkipoffset(evt, evt.onSkipAd);
                }
            }

            // update skip button and companions
            if (_castDisplay) {
                _castDisplay.adChanged(evt);
            }
        }

        function _castAdsStarted() {
            utils.addClass(_playerElement, 'jw-flag-ads');
            _controlbar.show(true);
        }

        function _castAdsEnded() {
            // controlbar reset
            this.setAltText('');
            utils.removeClass(_playerElement, 'jw-flag-ads');
            _controlbar.show(true);
            // cast display reset
            if (_castDisplay) {
                _castDisplay.adsEnded();
                _castDisplay.setState(_model.get('state'));
            }
            // display click reset
            _display.revertAlternateClickHandler();
        }

        /**
         * Switch fullscreen mode.
         **/
        var _fullscreen = this.fullscreen = function(state) {

            if (!utils.exists(state)) {
                state = !_model.get('fullscreen');
            }

            state = !!state;

            // if state is already correct, return
            if (state === _model.get('fullscreen')) {
                return;
            }

            // If it supports DOM fullscreen
            if (_elementSupportsFullscreen) {
                if (state) {
                    _requestFullscreen.apply(_playerElement);
                } else {
                    _exitFullscreen.apply(document);
                }
                _toggleDOMFullscreen(_playerElement, state);
            } else {
                if (utils.isIE()) {
                    _toggleDOMFullscreen(_playerElement, state);
                } else {
                    // else use native fullscreen
                    if (_instreamModel) {
                       _instreamModel.getVideo().setFullScreen(state);
                    }
                   _model.getVideo().setFullScreen(state);
                }
            }
        };


        function _redrawComponent(comp) {
            if (comp) {
                comp.redraw();
            }
        }

        /**
         * Resize the player
         */
        function _resize(width, height, resetAspectMode) {
            var className = _playerElement.className,
                playerStyle,
                id = _model.get('id') + '_view';
            cssUtils.block(id);

            // when jwResize is called remove aspectMode and force layout
            resetAspectMode = !!resetAspectMode;
            if (resetAspectMode) {
                className = className.replace(/\s*aspectMode/, '');
                if (_playerElement.className !== className) {
                    _playerElement.className = className;
                }
                cssUtils.style(_playerElement, {
                    display: JW_CSS_BLOCK
                }, resetAspectMode);
            }

            if (utils.exists(width) && utils.exists(height)) {
                _model.set('width', width);
                _model.set('height', height);
            }

            playerStyle = {
                width: width
            };
            if (!utils.hasClass(_playerElement, 'jw-flag-aspect-mode')) {
                playerStyle.height = height;
            }
            _styles(_playerElement, playerStyle, true);

            if (_controlbar) {
                _controlbar.redraw(true);
            }
            if (_logo) {
                _logo.offset(_controlbar && _logo.position().indexOf('bottom') >= 0 ?
                    _controlbar.element().clientHeight : 0);
            }

            _checkAudioMode(height);

            // pass width, height from jwResize if present
            _resizeMedia(width, height);

            cssUtils.unblock(id);
        }

        function _checkAudioMode(height) {
            _audioMode = _isAudioMode(height);
            if (_controlbar) {
                if (_audioMode) {
                    _controlbar.audioMode(true);
                    _showControls();
                    _showVideo(false);
                } else {
                    _controlbar.audioMode(false);
                    var model = _instreamMode ? _instreamModel : _model;
                    _updateState(model.get('state'));
                }
            }

            utils.toggleClass(_playerElement, 'jw-flag-audio-player', _audioMode);
        }

        function _isAudioMode(height) {
            if (_model.get('aspectratio')) {
                return false;
            }
            if (_.isNumber(height)) {
                return _isControlBarOnly(height);
            }
            if (_.isString(height) && height.indexOf('%') > -1) {
                return false;
            }
            return _isControlBarOnly(_bounds(_container).height);
        }

        function _isControlBarOnly(verticalPixels) {
            return verticalPixels && verticalPixels <= 40;
        }

        function _resizeMedia(width, height) {
            if (!width || isNaN(Number(width))) {
                if (!_videoLayer) {
                    return;
                }
                width = _videoLayer.clientWidth;
            }
            if (!height || isNaN(Number(height))) {
                if (!_videoLayer) {
                    return;
                }
                height = _videoLayer.clientHeight;
            }
            //IE9 Fake Full Screen Fix
            if (utils.isMSIE(9) && document.all && !window.atob) {
                width = height = '100%';
            }

            var provider = _model.getVideo();
            if (!provider) {
                return;
            }
            var transformScale = provider.resize(width, height, _model.get('stretching'));

            // poll resizing if video is transformed
            if (transformScale) {
                clearTimeout(_resizeMediaTimeout);
                _resizeMediaTimeout = setTimeout(_resizeMedia, 250);
            }
            _captionsRenderer.resize();
        }

        this.resize = function(width, height) {
            var resetAspectMode = true;
            _resize(width, height, resetAspectMode);
            _responsiveListener();
        };
        this.resizeMedia = _resizeMedia;

        this.reset = function(){
            if (document.contains(_playerElement)) {
                _playerElement.parentNode.replaceChild(_originalContainer, _playerElement);
            }
            utils.emptyElement(_playerElement);
        };

        /**
         * Return whether or not we're in native fullscreen
         */
        function _isNativeFullscreen() {
            if (_elementSupportsFullscreen) {
                var fsElement = document.fullscreenElement ||
                    document.webkitCurrentFullScreenElement ||
                    document.mozFullScreenElement ||
                    document.msFullscreenElement;
                return !!(fsElement && fsElement.id === _model.get('id'));
            }
            // if player element view fullscreen not available, return video fullscreen state
            return  _instreamMode ? _instreamModel.getVideo().getFullScreen() :
                        _model.getVideo().getFullScreen();
        }


        function _fullscreenChangeHandler(event) {
            var fullscreenState = (event.jwstate !== undefined) ? event.jwstate : _isNativeFullscreen();
            if (_elementSupportsFullscreen) {
                _toggleDOMFullscreen(_playerElement, fullscreenState);
            } else {
                _toggleFullscreen(fullscreenState);
            }
        }

        function _toggleDOMFullscreen(playerElement, fullscreenState) {
            utils.removeClass(playerElement, 'jw-flag-fullscreen');
            if (fullscreenState) {
                utils.addClass(playerElement, 'jw-flag-fullscreen');
                _styles(document.body, {
                    'overflow-y': 'hidden'
                });

                // On going fullscreen we want the control bar to fade after a few seconds
                _resetTapTimer();
            } else {
                _styles(document.body, {
                    'overflow-y': ''
                });
            }

            _redrawComponent(_controlbar);
            _resizeMedia();

            _toggleFullscreen(fullscreenState);
        }

        function _toggleFullscreen(fullscreenState) {
            // update model
            _model.setFullscreen(fullscreenState);
            if (_instreamModel) {
                _instreamModel.setFullscreen(fullscreenState);
            }

            var model = _instreamMode ? _instreamModel : _model;
            if (fullscreenState) {
                // Browsers seem to need an extra second to figure out how large they are in fullscreen...
                clearTimeout(_resizeMediaTimeout);
                _resizeMediaTimeout = setTimeout(_resizeMedia, 200);

            } else if (_isIPad && model.get('state') === states.PAUSED) {
                // delay refresh on iPad when exiting fullscreen
                // TODO: cancel this if fullscreen or player state changes
                setTimeout(_showDisplay, 500);
            }
        }

        function _showControlbar() {
            if (_controlbar && _model.get('controls')) {
                _controlbar.show();
            }
        }

        function _hideControlbar() {
            if (utils.hasClass(_controlsLayer), 'jw-casting') {
                return;
            }

            // TODO: use _forcedControlsState for audio mode so that we don't need these
            if (_controlbar && !_audioMode && !_model.getVideo().isAudioFile()) {
                _controlbar.hide();
            }
        }

        function _showDisplay() {
            // debug this, find out why
            if (!(_isMobile && _model.get('fullscreen'))) {
                _model.getVideo().setControls(false);
            }
        }

        function _hideControls() {
            clearTimeout(_controlsTimeout);
            _showing = false;

            var model = _instreamMode ? _instreamModel : _model;
            var state = model.get('state');

            if (!_model.get('controls') || state !== states.PAUSED) {
                _hideControlbar();
            }

            utils.addClass(_playerElement, 'jw-flag-user-inactive');
        }

        function _showControls() {
            _showing = true;
            if (_model.get('controls') || _audioMode) {
                _showControlbar();
            }

            utils.removeClass(_playerElement, 'jw-flag-user-inactive');
        }

        function _showVideo(state) {
            state = state && !_audioMode;
            _model.getVideo().setVisibility(state);
        }

        function _playlistCompleteHandler() {
            _replayState = true;
            _fullscreen(false);
            if (_model.get('controls')) {
            }
        }

        function _playlistItemHandler() {
            // update display title
            if (_castDisplay) {
                _castDisplay.setState(_model.get('state'));
            }
            _model.mediaModel.on('change:isLive', function(model, isLive){
                utils.toggleClass(_playerElement, 'jw-flag-live', isLive);
                _this.setAltText((isLive) ? 'Live Broadcast' : '');
            }, this);
        }

        function _stateHandler(model, state) {
            _replayState = false;
            _updateState(state);
        }

        function _errorHandler() {
            _hideControlbar();
        }

        function _isAudioFile() {
            var model = _instreamMode ? _instreamModel : _model;
            var provider = model.getVideo();
            if (provider) {
                return provider.isAudioFile();
            }
            return false;
        }

        function _isCasting() {
            var provider = _model.getVideo();
            if (provider) {
                return provider.isCaster;
            }
            return false;
        }

        function _updateState(state) {
            utils.removeClass(_playerElement, 'jw-state-' + _currentState);
            utils.addClass(_playerElement, 'jw-state-' + state);
            _currentState = state;
            // cast.display
            if (_isCasting()) {

                // TODO: needs to be done in the provider.setVisibility
                utils.addClass(_videoLayer, 'jw-media-show');

                // force control bar without audio check
                if (_controlbar) {
                    _controlbar.show();
                    _controlbar.hideFullscreen(true);
                }
                return;
            }
            // player display
            switch (state) {
                case states.PLAYING:
                    if (_isAudioFile()) {
                        _showVideo(false);
                        if (_controlbar) {
                            _showControls();
                            _controlbar.hideFullscreen(true);
                        }
                    } else {
                        _showVideo(true);

                        _resizeMedia();
                        if (_controlbar) {
                            _controlbar.hideFullscreen(!_model.getVideo().supportsFullscreen());
                        }
                    }
                    break;
                case states.IDLE:
                case states.COMPLETE:
                    _showVideo(false);
                    if (!_audioMode) {
                        _showDisplay();
                        if (_controlbar) {
                            _controlbar.hideFullscreen(false);
                        }
                    }
                    break;
                case states.BUFFERING:
                    _showDisplay();
                    _hideControls();
                    if (_isMobile) {
                        _showVideo(true);
                    }
                    break;
                case states.PAUSED:
                    _showDisplay();
                    _showControls();
                    break;
            }
        }

        this.setupInstream = function(instreamModel) {
            _instreamModel = instreamModel;
            _instreamModel.on('change:controls', _onChangeControls);
            _instreamMode = true;
            utils.addClass(_playerElement, 'jw-flag-ads');
            _controlbar.show(true);
        };

        this.setAltText = function(text) {
            _controlbar.setAltText(text);
        };

        this.showInstream = function() {
            // adds video tag to video layer
            var provider = _instreamModel.getVideo();
            provider.setContainer(_videoLayer);
            provider.setVisibility(true);
            _controlbar.show(true);
        };

        this.destroyInstream = function() {
            _instreamMode = false;
            this.setAltText('');
            utils.removeClass(_playerElement, 'jw-flag-ads');
            _controlbar.show(true);
            var provider = _model.getVideo();
            provider.setContainer(_videoLayer);
            provider.setVisibility(true);
        };

        this.addCues = function(cues) {
            if (_controlbar) {
                _controlbar.addCues(cues);
            }
        };

        this.displayComp = function() {
            return _display;
        };

        this.controlsContainer = function() {
            return _controlsLayer;
        };

        this.getContainer = this.element = function() {
            return _playerElement;
        };

        this.getSafeRegion = function(includeCB) {
            var bounds = {
                x: 0,
                y: 0,
                width: 0,
                height: 0
            };

            includeCB = includeCB || !utils.exists(includeCB);

            var dispBounds = _bounds(_container),
                dispOffset = dispBounds.top,
                cbBounds = _controlbar.getVisibleBounds(),
                dockButtons = _model.get('dock'),
                logoTop = (_logo.position().indexOf('top') === 0),
                dockBounds,
                logoBounds = _bounds(_logo.element());
            if (dockButtons && dockButtons.length && _model.get('controls')) {
                dockBounds = _bounds(_dock.element());
                bounds.y = Math.max(0, dockBounds.bottom - dispOffset);
            }
            if (logoTop) {
                bounds.y = Math.max(bounds.y, logoBounds.bottom - dispOffset);
            }
            bounds.width = dispBounds.width;
            if (cbBounds.height && includeCB && _model.get('controls')) {
                bounds.height = (logoTop ? cbBounds.top : logoBounds.top) - dispOffset - bounds.y;
            } else {
                bounds.height = dispBounds.height - bounds.y;
            }
            return bounds;
        };

        this.destroy = function() {
            window.removeEventListener('resize', _responsiveListener);
            window.removeEventListener('orientationchange', _responsiveListener);
            for (var i = DOCUMENT_FULLSCREEN_EVENTS.length; i--;) {
                document.removeEventListener(DOCUMENT_FULLSCREEN_EVENTS[i], _fullscreenChangeHandler, false);
            }
            if (_model.mediaController) {
                _model.mediaController.off('fullscreenchange', _fullscreenChangeHandler);
            }
            _playerElement.removeEventListener('keydown', handleKeydown, false);
            if (_rightClickMenu) {
                _rightClickMenu.destroy();
            }
            if (_castDisplay) {
                _model.off('change:state', _castDisplay.statusDelegate);
                _castDisplay.destroy();
                _castDisplay = null;
            }
            if (_controlsLayer) {
                _controlsLayer.removeEventListener('mousemove', _startFade);
                _controlsLayer.removeEventListener('mouseout', _mouseoutHandler);
            }
            if (_videoLayer) {
                _videoLayer.removeEventListener('mousemove', _startFade);
                _videoLayer.removeEventListener('click', _display.clickHandler);
            }
            if (_instreamMode) {
                this.destroyInstream();
            }
        };
    };

    return View;
});
