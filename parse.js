
var Parser = require("./parser");
var Map = require("collections/map");

var makeTrie = require("./lib/trie");
var makeParserFromTrie = require("./lib/trie-parser");
var makeLeftToRightParser = require("./lib/l2r-parser");

function makeOperatorParser(operators, parseOperator) {
    return function (callback) {
        return parseOperator(function (operator, rewind) {
            if (operator && operators.indexOf(operator) !== -1) {
                return callback(operator);
            } else {
                return rewind(callback());
            }
        });
    };
}

var operators = {
    "**": "pow",
    "*": "mul",
    "/": "div",
    "%": "mod",
    "%%": "rem",
    "+": "add",
    "-": "sub",
    "<": "lt",
    ">": "gt",
    "<=": "le",
    ">=": "ge",
    "=": "equals",
    "==": "equals",
    "!=": "notEquals",
    "&&": "and",
    "||": "or"
};

var operatorTrie = makeTrie(operators);
var parseOperator = makeParserFromTrie(operatorTrie);

module.exports = parse;
function parse(text) {
    if (Array.isArray(text)) {
        return {
            type: "tuple",
            args: text.map(parse)
        };
    } else {
        return parse.semantics.parse(text);
    }
}

parse.semantics = {

    grammar: function () {
        var self = this;
        self.precedence(function () {
            return self.parseNegation.bind(self);
        });
        self.makeLeftToRightParser(["pow"]);
        self.makeLeftToRightParser(["mul", "div", "mod", "rem"]);
        self.makeLeftToRightParser(["add", "sub"]);
        self.makeLeftToRightParser(["and"]);
        self.makeLeftToRightParser(["or"]);
        self.makeLeftToRightParser(["xor"]);
        self.parseExpression = self.makeComparisonParser();
        self.parseMemoized = Parser.makeParser(self.parseExpression);
    },

    memo: new Map(),

    parse: function (text) {
        if (this.memo.has(text)) {
            return this.memo.get(text);
        } else {
            var syntax = this.parseMemoized(text);
            this.memo.set(text, syntax);
            return syntax;
        }
    },

    makeSyntax: function (operator, left, right) {
        return {type: operator, args: [left, right]};
    },

    makeLeftToRightParser: function (operators) {
        var self = this;
        return self.precedence(function (parsePrevious) {
            return makeLeftToRightParser(
                parsePrevious,
                makeOperatorParser(operators, self.parseOperator.bind(self)),
                self.makeSyntax
            );
        });
    },

    precedence: function (callback) {
        callback = callback || identity;
        this.parsePrevious = callback(this.parsePrevious);
        return this.parsePrevious;
    },

    parseDot: Parser.makeExpect("."),
    parseBlockBegin: Parser.makeExpect("{"),
    parseBlockEnd: Parser.makeExpect("}"),
    parseTupleBegin: Parser.makeExpect("("),
    parseTupleEnd: Parser.makeExpect(")"),
    parseRecordBegin: Parser.makeExpect("{"),
    parseRecordEnd: Parser.makeExpect("}"),
    parseColon: Parser.makeExpect(":"),

    skipWhiteSpace: function skipWhiteSpace(callback) {
        return function (character) {
            if (character === " ") {
                return skipWhiteSpace(callback);
            } else {
                return callback()(character);
            }
        };
    },

    parseWord: function parseWord(callback, word) {
        word = word || "";
        return function (character, loc) {
            if (/[\w\d]/.test(character)) {
                return parseWord(callback, word + character);
            } else if (word !== "") {
                return callback(word)(character, loc);
            } else {
                return callback()(character, loc);
            }
        };
    },

    parseStringTail: function parseStringTail(callback, string) {
        var self = this;
        return function (character) {
            if (character === "'") {
                return callback({
                    type: "literal",
                    value: string
                });
            } else if (character === "\\") {
                return function (character) {
                    return self.parseStringTail(callback, string + character);
                };
            } else {
                return self.parseStringTail(callback, string + character);
            }
        };
    },

    parsePrimary: function parsePrimary(callback, previous) {
        var self = this;
        previous = previous || {type: "value"};
        return function (character) {
            if (character === "#") {
                return self.parseNumber(callback);
            } else if (character === "*") {
                return callback({
                    type: "content",
                    args: [previous]
                });
            } else if (character === "$") {
                return self.parsePrimary(callback, {
                    type: "parameters"
                });
            } else if (character === "'") {
                return self.parseStringTail(callback, "");
            } else if (character === "(") {
                return self.parseTuple(callback)(character);
            } else if (character === "{") {
                return self.parseRecord(callback)(character);
            } else {
                return self.parseValue(callback, previous)(character);
            }
        };
    },

    parseNumber: function parseNumber(callback) {
        var self = this;
        return self.parseWord(function (word) {
            return callback({
                type: "literal",
                value: +word
            });
        })
    },

    parseValue: function parseValue(callback, previous) {
        var self = this;
        return self.parseWord(function (identifier) {
            if (identifier) {
                return function (character) {
                    if (character === "{") {
                        return self.parseBlock(function (expression) {
                            if (identifier === "map") {
                                return self.parseTail(callback, {
                                    type: "map",
                                    args: [
                                        previous,
                                        expression
                                    ]
                                });
                            } else {
                                if (expression.type === "value") {
                                    return self.parseTail(callback, {
                                        type: identifier,
                                        args: [previous]
                                    });
                                } else {
                                    return self.parseTail(callback, {
                                        type: identifier,
                                        args: [
                                            {
                                                type: "map",
                                                args: [
                                                    previous,
                                                    expression
                                                ]
                                            }
                                        ]
                                    });
                                }
                            }
                        })(character);
                    } else if (character === "(") {
                        return self.parseTuple(function (tuple) {
                            return self.parseTail(callback, {
                                type: identifier,
                                args: [previous].concat(tuple.args)
                            });
                        }, previous)(character);
                    } else {
                        return self.parseTail(callback, {
                            type: "property",
                            args: [
                                previous,
                                {
                                    type: "literal",
                                    value: identifier
                                }
                            ]
                        })(character);
                    }
                };
            } else {
                return callback(previous);
            }
        });
    },

    parseTail: function (callback, previous) {
        var self = this;
        return self.parseDot(function (dot) {
            if (dot) {
                return self.parsePrimary(callback, previous);
            } else {
                return callback(previous);
            }
        });
    },

    parseBlock: function (callback) {
        var self = this;
        return self.parseBlockBegin(function (begin) {
            if (begin) {
                return self.parseExpression(function (expression) {
                    return self.parseBlockEnd(function (end, loc) {
                        if (end) {
                            return callback(expression);
                        } else {
                            var error = new Error("Expected \")\"");
                            error.loc = loc;
                            throw error;
                        }
                    });
                })
            } else {
                return callback();
            }
        });
    },

    parseTuple: function (callback) {
        var self = this;
        return self.parseTupleBegin(function (begin) {
            if (begin) {
                return self.parseTupleInternal(function (args) {
                    return self.parseTupleEnd(function (end, loc) {
                        if (end) {
                            return callback({
                                type: "tuple",
                                args: args
                            });
                        } else {
                            var error = new Error("Expected \")\"");
                            error.loc = loc;
                            throw error;
                        }
                    });
                });
            } else {
                return callback();
            }
        });
    },

    parseTupleInternal: function (callback, args) {
        var self = this;
        args = args || [];
        return function (character) {
            if (character === ")") {
                return callback(args)(character);
            } else {
                return self.parseExpression(function (expression) {
                    args.push(expression);
                    return function (character) {
                        if (character === ",") {
                            return self.skipWhiteSpace(function () {
                                return self.parseTupleInternal(callback, args);
                            });
                        } else {
                            return callback(args)(character);
                        }
                    };
                })(character);
            }
        };
    },

    parseRecord: function (callback) {
        var self = this;
        return self.parseRecordBegin(function (begin) {
            if (begin) {
                return self.parseRecordInternal(function (args) {
                    return self.parseRecordEnd(function (end, loc) {
                        if (end) {
                            return callback({
                                type: "record",
                                args: args
                            });
                        } else {
                            var error = new Error("Expected \"}\"");
                            error.loc = loc;
                            throw error;
                        }
                    });
                });
            } else {
                return callback();
            }
        });
    },

    parseRecordInternal: function (callback, args) {
        var self = this;
        args = args || {};
        return self.parseWord(function (key) {
            // TODO eponymous key/value
            return self.parseColon(function (colon) {
                return self.skipWhiteSpace(function () {
                    return self.parseExpression(function (value) {
                        args[key] = value;
                        return function (character) {
                            if (character === ",") {
                                return self.skipWhiteSpace(function () {
                                    return self.parseRecordInternal(callback, args);
                                });
                            } else {
                                return callback(args)(character);
                            }
                        };
                    });
                });
            });
        });
    },

    parseNegation: function (callback) {
        var self = this;
        var parsePrevious = self.parsePrimary.bind(self);
        return function (character) {
            if (character === "!") {
                return parsePrevious(function (expression) {
                    return callback({type: "not", args: [
                        expression
                    ]});
                });
            } else if (character === "-") {
                return parsePrevious(function (expression) {
                    return callback({type: "neg", args: [
                        expression
                    ]});
                });
            } else {
                return parsePrevious(callback)(character);
            }
        };
    },

    makeComparisonParser: function () {
        var self = this;
        var comparisons = ["equals", "lt", "gt", "le", "ge"];
        return self.precedence(function (parsePrevious) {
            return function (callback) {
                return parsePrevious(function (left) {
                    return self.parseOperator(function (operator, rewind) {
                        if (comparisons.indexOf(operator) != -1) {
                            return parsePrevious(function (right) {
                                return callback({type: operator, args: [
                                    left,
                                    right
                                ]});
                            });
                        } else if (operator === "notEquals") {
                            return parsePrevious(function (right) {
                                return callback({type: "not", args: [
                                    {type: "equals", args: [
                                        left,
                                        right
                                    ]}
                                ]});
                            });
                        } else {
                            return rewind(callback(left));
                        }
                    });
                });
            };
        });
    },

    parseOperator: function (callback) {
        var self = this;
        return self.skipWhiteSpace(function () {
            return parseOperator(function (op, rewind) {
                return self.skipWhiteSpace(function () {
                    return callback(op, rewind);
                });
            });
        });
    }

};

parse.semantics.grammar();

function identity(x) { return x }

