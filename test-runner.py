"""Collect real unittest results for the local CodeStudio test panel."""
import json
import os
import sys
import traceback
import unittest

root, directory, pattern, destination = sys.argv[1:]
sys.path.insert(0, root)
os.chdir(root)


class Result(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cases = []

    def record(self, test, status, detail=""):
        if len(self.cases) < 1000:
            self.cases.append({"id": test.id(), "status": status, "detail": detail[-8000:]})

    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, "passed")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.record(test, "failed", self._exc_info_to_string(err, test))

    def addError(self, test, err):
        super().addError(test, err)
        self.record(test, "error", self._exc_info_to_string(err, test))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.record(test, "skipped", reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self.record(test, "expectedFailure", self._exc_info_to_string(err, test))

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.record(test, "unexpectedSuccess")

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err:
            self.record(subtest, "failed", self._exc_info_to_string(err, test))


try:
    suite = unittest.defaultTestLoader.discover(directory, pattern=pattern, top_level_dir=root)
    result = unittest.TextTestRunner(verbosity=2, resultclass=Result).run(suite)
    report = {"cases": result.cases, "testsRun": result.testsRun}
    success = result.wasSuccessful()
except BaseException:
    report = {"cases": [{"id": "discovery", "status": "error", "detail": traceback.format_exc()[-8000:]}]}
    success = False
with open(destination, "w", encoding="utf-8") as file:
    json.dump(report, file, ensure_ascii=False)
sys.exit(0 if success else 1)
