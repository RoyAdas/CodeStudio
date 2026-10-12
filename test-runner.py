"""Collect real unittest results for the local CodeStudio test panel."""
import json
import os
import sys
import traceback
import unittest
import pathlib

root, directory, pattern, destination = sys.argv[1:5]
framework = sys.argv[5] if len(sys.argv) > 5 else 'unittest'
with_coverage = len(sys.argv) > 6 and sys.argv[6] == '1'
selected = json.loads(sys.argv[7]) if len(sys.argv) > 7 else []
if (framework == 'pytest' or with_coverage) and sys.version_info < (3, 10):
    raise RuntimeError('pytest and branch coverage require Python 3.10 or newer.')
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / 'python-runtime' / 'lib'))
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
    coverage = None
    if with_coverage:
        import coverage as coverage_module
        coverage = coverage_module.Coverage(data_file=None, branch=True, source=[root], omit=['*/test*.py', '*/.venv/*', '*/venv/*'])
        coverage.start()
    if framework == 'pytest':
        import pytest
        cases = []
        class Plugin:
            def pytest_runtest_logreport(self, report):
                if len(cases) >= 1000:
                    return
                if report.when == 'call' or (report.when != 'call' and report.failed):
                    status = 'passed' if report.passed else 'skipped' if report.skipped else 'failed' if report.when == 'call' else 'error'
                    if hasattr(report, 'wasxfail'):
                        status = 'expectedFailure' if report.skipped else 'unexpectedSuccess'
                    cases.append({'id': report.nodeid, 'status': status, 'detail': str(report.longrepr or '')[-8000:]})
                elif report.when == 'setup' and report.skipped:
                    cases.append({'id': report.nodeid, 'status': 'skipped', 'detail': str(report.longrepr or '')[-8000:]})
            def pytest_collectreport(self, report):
                if report.failed:
                    cases.append({'id': report.nodeid, 'status': 'error', 'detail': str(report.longrepr)[-8000:]})
        code = pytest.main([*(selected or [directory]), '-q', '--tb=short', '-p', 'no:cacheprovider', '-o', 'python_files=' + pattern], plugins=[Plugin()])
        report = {'cases': cases, 'testsRun': len(cases)}
        success = code == 0
    else:
        suite = unittest.defaultTestLoader.discover(directory, pattern=pattern, top_level_dir=root)
        if selected:
            selected_set = set(selected)
            def leaves(tests):
                for item in tests:
                    if isinstance(item, unittest.TestSuite):
                        yield from leaves(item)
                    else:
                        yield item
            suite = unittest.TestSuite(item for item in leaves(suite) if item.id() in selected_set)
        result = unittest.TextTestRunner(verbosity=2, resultclass=Result).run(suite)
        report = {"cases": result.cases, "testsRun": result.testsRun}
        success = result.wasSuccessful()
    if coverage:
        coverage.stop()
        report_path = destination + '.coverage'
        coverage.json_report(outfile=report_path, ignore_errors=True)
        raw = json.loads(pathlib.Path(report_path).read_text(encoding='utf-8'))
        pathlib.Path(report_path).unlink()
        measured = {}
        for name, info in raw.get('files', {}).items():
            file = pathlib.Path(name).resolve()
            try:
                relative = file.relative_to(pathlib.Path(root)).as_posix()
            except ValueError:
                continue
            measured[relative] = {key: info.get(key, []) for key in ['executed_lines', 'missing_lines', 'missing_branches']}
            measured[relative]['summary'] = info.get('summary', {})
        report['coverage'] = {'files': measured, 'totals': raw.get('totals', {})}
except BaseException:
    report = {"cases": [{"id": "discovery", "status": "error", "detail": traceback.format_exc()[-8000:]}]}
    success = False
with open(destination, "w", encoding="utf-8") as file:
    json.dump(report, file, ensure_ascii=False)
sys.exit(0 if success else 1)
