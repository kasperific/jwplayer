define([
    'utils/helpers',
    'utils/underscore',
    'utils/backbone.events',
    'view/components/slider',
    'view/components/timeslider',
    'view/components/menu',
    'view/components/volumetooltip'
], function(utils, _, Events, Slider, TimeSlider, Menu, VolumeTooltip) {

    function button(icon, click) {
        var element = document.createElement('span');
        element.className = 'jw-icon jw-icon-inline ' + icon;
        element.style.display = 'none';

        if (click) {
            element.onclick = function() { click(); };
        }

        return {
            element : function() { return element; },
            toggle : function(m) {
                if (m) {
                    this.show();
                } else {
                    this.hide();
                }
            },
            show : function() { element.style.display = '';},
            hide : function() { element.style.display = 'none';}
        };
    }

    function text(name) {
        var element = document.createElement('span');
        element.className = 'jw-text ' + name;
        return element;
    }

    function menu(name) {
        var createdMenu = new Menu(name);

        return createdMenu;
    }

    function buildGroup(group, elements) {
        var elem = document.createElement('span');
        elem.className = 'jw-group jw-controlbar-' + group+'-group';

        _.each(elements, function(e) {
            if (e.element) {
                e = e.element();
            }
            elem.appendChild(e);
        });

        return elem;
    }

    function Controlbar(_api, _model) {
        this._api = _api;
        this._model = _model;

        this.setup();
    }

    _.extend(Controlbar.prototype, Events, {

        setup : function() {
            this.build();
            this.initialize();
        },

        build : function() {

            var timeSlider = new TimeSlider(this._model, this._api);
            var volumeSlider = new Slider('jw-slider-volume', 'horizontal');
            var volumeTooltip = new VolumeTooltip(this._model, 'jw-icon-volume');

            this.elements = {
                alt: text('jw-text-alt'),
                play: button('jw-icon-playback', this._api.play),
                prev: button('jw-icon-prev', this._api.playlistPrev),
                next: button('jw-icon-next', this._api.playlistNext),
                elapsed: text('jw-text-elapsed'),
                time: timeSlider,
                duration: text('jw-text-duration'),
                hd: menu('jw-icon-hd'),
                cc: menu('jw-icon-cc'),
                mute: button('jw-icon-volume', this._api.setMute),
                volume: volumeSlider,
                volumetooltip: volumeTooltip,
                cast: button('jw-icon-cast'),
                fullscreen: button('jw-icon-fullscreen', this._api.setFullscreen)
            };

            this.layout = {
                left: [
                    this.elements.play,
                    this.elements.prev,
                    this.elements.next,
                    this.elements.elapsed
                ],
                center: [
                    this.elements.time,
                    this.elements.alt
                ],
                right: [
                    this.elements.duration,
                    this.elements.hd,
                    this.elements.cc,
                    this.elements.mute,
                    this.elements.volume,
                    this.elements.cast,
                    this.elements.fullscreen
                ]
            };

            this.el = document.createElement('span');
            this.el.className = 'jw-container jw-controlbar';

            var leftGroup = buildGroup('left', this.layout.left);
            var centerGroup = buildGroup('center', this.layout.center);
            var rightGroup = buildGroup('right', this.layout.right);

            this.el.appendChild(leftGroup);
            this.el.appendChild(centerGroup);
            this.el.appendChild(rightGroup);
        },

        initialize : function() {
            // Initial State
            this.elements.play.show();
            this.elements.fullscreen.show();
            this.elements.mute.show();
            this.onVolume(this._model, this._model.get('volume'));
            this.onPlaylist(this._model, this._model.get('playlist'));
            this.onPlaylistItem(this._model, this._model.get('playlistItem'));
            this.onCastAvailable(this._model, this._model.get('castAvailable'));
            this.onCaptionsList(this._model, this._model.get('captionsList'));

            // Listen for model changes
            this._model.on('change:volume', this.onVolume, this);
            this._model.on('change:mute', this.onMute, this);
            this._model.on('change:playlist', this.onPlaylist, this);
            this._model.on('change:playlistItem', this.onPlaylistItem, this);
            this._model.on('change:castAvailable', this.onCastAvailable, this);
            this._model.on('change:duration', this.onDuration, this);
            this._model.on('change:position', this.onElapsed, this);
            this._model.on('change:fullscreen', this.onFullscreen, this);
            this._model.on('change:captionsList', this.onCaptionsList, this);
            this._model.on('change:captionsIndex', this.onCaptionsIndex, this);

            // Event listeners
            this.elements.volume.on('update', function(pct) {
                var val = pct.percentage;
                this._api.setVolume(val);
            }, this);
            this.elements.volumetooltip.on('update', function(pct) {
                var val = pct.percentage;
                this._api.setVolume(val);
            }, this);

            this.elements.hd.on('select', function(value){
                this._model.getVideo().setCurrentQuality(value);
            }, this);
            this.elements.hd.on('toggle', function(){
                this._model.getVideo().setCurrentQuality((this._model.getVideo().getCurrentQuality() === 0) ? 1 : 0);
            }, this);

            this.elements.cc.on('select', function(value) {
                this._api.setCurrentCaptions(value);
            }, this);
            this.elements.cc.on('toggle', function() {
                var index = this._model.get('captionsIndex');
                this._api.setCurrentCaptions(index ? 0 : 1);
            }, this);

            this.elements.volumetooltip.on('toggle', function(){
                this._api.setMute();
            }, this);
        },

        onCaptionsList: function(model, tracks) {
            var index = model.get('captionsIndex');
            this.elements.cc.setup(tracks, index);
        },
        onCaptionsIndex: function(model, index) {
            this.elements.cc.selectItem(index);
        },
        onPlaylist : function(model, playlist) {
            var display = (playlist.length > 1);
            this.elements.next.toggle(display);
            this.elements.prev.toggle(display);
        },
        onPlaylistItem : function(/*model, item*/) {
            this.elements.time.updateBuffer(0);
            this.elements.time.render(0);
            this.elements.duration.innerHTML = '00:00';
            this.elements.elapsed.innerHTML = '00:00';

            this._model.mediaModel.on('change:levels', function(model, levels) {
                this.elements.hd.setup(levels, model.get('currentLevel'));
            }, this);
            this._model.mediaModel.on('change:currentLevel', function(model, level) {
                this.elements.hd.selectItem(level);
            }, this);
        },
        onVolume : function(model, pct) {
            this.renderVolume(model.get('mute'), pct);
        },
        onMute : function(model, muted) {
            this.renderVolume(muted, model.get('volume'));
        },
        renderVolume : function(muted, vol) {
            utils.toggleClass(this.elements.mute.element(), 'jw-off', muted);
            utils.toggleClass(this.elements.volumetooltip.element(), 'jw-off', muted);
            this.elements.volume.render(muted ? 0 : vol);
            this.elements.volumetooltip.volumeSlider.render(muted ? 0 : vol);
        },
        onCastAvailable : function(model, val) {
            this.elements.cast.toggle(val);
        },
        onElapsed : function(model, val) {
            this.elements.elapsed.innerHTML = utils.timeFormat(val);
        },
        onDuration : function(model, val) {
            this.elements.duration.innerHTML = utils.timeFormat(val);
        },
        onFullscreen : function(model, val) {
            utils.toggleClass(this.elements.fullscreen.element(), 'jw-off', val);
        },

        element: function() {
            return this.el;
        },

        redraw : utils.noop,
        hide : utils.noop,
        show : utils.noop,
        audioMode : utils.noop,
        hideFullscreen : utils.noop,
        setAltText : function(altText) {
            this.elements.alt.innerHTML = altText;
        },
        addCues : function(cues) {
            if (this.elements.time) {
                _.each(cues, function(ele){
                    this.elements.time.addCue(ele);
                }, this);
                this.elements.time.drawCues();
            }
        }
    });

    return Controlbar;
});
