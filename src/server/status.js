const Status = (module.exports = {
    code: 1,
    change: function(code) {
        Status.code = code;
    },
    get: function() {
        return Status.code;
    }
});
