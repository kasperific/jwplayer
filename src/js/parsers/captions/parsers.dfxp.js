define([
    'utils/helpers',
    'utils/strings'
], function(utils, strings) {

    /** Component that loads and parses an DFXP file. **/
    var dfxp = function () {
        var _seconds = utils.seconds;

        this.parse = function (data) {
            var _captions = [
                {
                    begin: 0,
                    text: ''
                }
            ];
            data = strings.trim(data).replace(/tts?:/g, '');
            var list = data.split('</p>');
            var newlist = [];
            for (var i = 0; i < list.length; i++) {
                if (list[i].indexOf('<p') >= 0) {
                    list[i] = strings.trim(list[i].substr(list[i].indexOf('<p') + 2));
                    newlist.push(list[i]);
                }
            }
            list = newlist;

            for (i = 0; i < list.length; i++) {
                var entry = _entry(list[i]);
                if (entry.text) {
                    _captions.push(entry);
                    // Insert empty caption at the end.
                    if (entry.end) {
                        _captions.push({
                            begin: entry.end,
                            text: ''
                        });
                        delete entry.end;
                    }
                }
            }
            if (_captions.length > 1) {
                return _captions;
            } else {
                throw {
                    message: 'Invalid DFXP file:'
                };
            }
        };


        /** Parse a single captions entry. **/
        function _entry(data) {
            var entry = {};

            utils.tryCatch(function() {
                var idx = data.indexOf('begin=\"');
                data = data.substr(idx + 7);
                idx = data.indexOf('\" end=\"');
                entry.begin = _seconds(data.substr(0, idx));
                data = data.substr(idx + 7);
                idx = data.indexOf('\"');
                entry.end = _seconds(data.substr(0, idx));
                idx = data.indexOf('\">');
                data = data.substr(idx + 2);
                entry.text = strings.trim(data).replace(/>\s+</g, '><');
            });

            return entry;
        }

    };

    return dfxp;
});
