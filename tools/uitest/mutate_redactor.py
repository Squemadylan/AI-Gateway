#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""变异测试：证明「流式保真 / 脱敏还原」这套测试网真的会红。

只绿不红的测试等于装饰。这里对 `PrivacyRedactor` 手工种三个**历史上真发生过**
或**最可能发生**的错，逐个跑测试，看断言是否变红；跑完无条件恢复原文件。

三个变异（都取自本项目真实踩过的坑，不是随便乱改）：

  M1  回看窗口上限 -1：原实现用 `maxPlaceholderLength - 1`，
      于是「整个占位符正好落在 chunk 末尾」这种情况永远看不到，
      把完整占位符的最后两个字符扣下 → 占位符泄漏给客户端。
  M2  丢掉流尾：`flush()` 直接返回空串，
      于是被切开后半截的占位符永远凑不齐 → 还原出的内容缺一截。
  M3  不还原最后一个映射：`restore()` 少走一条映射，
      于是某一类敏感串在客户端侧永远是占位符。

判据：M1/M2/M3 每一个都必须让测试变红。任何一个仍绿，说明测试网覆盖不到它，
本轮不算完成。

用法（项目根目录）：
    python tools/uitest/mutate_redactor.py            # 跑全部三个变异
    python tools/uitest/mutate_redactor.py M1         # 只跑一个
退出码：0 = 全部按预期变红且已恢复；1 = 有变异没被抓住；2 = 环境/恢复出错。
"""

import hashlib
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "core", "src", "main", "kotlin", "dev", "aigw", "core", "security", "PrivacyRedactor.kt")
BACKUP_DIR = os.path.join(ROOT, ".tmp", "mutation")
BACKUP = os.path.join(BACKUP_DIR, "PrivacyRedactor.kt.orig")

TEST_FILTERS = [
    "dev.aigw.core.gateway.StreamFidelityTest",
    "dev.aigw.core.security.PrivacyRedactorTest",
]

# ---------------------------------------------------------------- 变异定义

MUTATIONS = {
    # M1：回看窗口上限 -1（原实现）
    "M1": {
        "why": "回看上限少 1 → 完整占位符落在帧末尾时被扣下，占位符泄漏",
        "find": "val limit = minOf(pending.length, session.maxPlaceholderLength)",
        "replace": "val limit = minOf(pending.length, session.maxPlaceholderLength - 1)",
        "extra": [
            (
                "                // 已经是完整占位符：立即交出，别当成前缀\n"
                "                if (session.placeholderKeys.contains(suffix)) return 0\n",
                "",
            )
        ],
    },
    # M2：丢掉流尾
    "M2": {
        "why": "flush 直接返回空 → 被切开的占位符后半截永久丢失，内容缺一截",
        "find": (
            "        fun flush(): String {\n"
            "            if (!session.active || pending.isEmpty()) return \"\"\n"
            "            val out = session.restore(pending.toString())\n"
            "            pending.setLength(0)\n"
            "            return out\n"
            "        }"
        ),
        "replace": (
            "        fun flush(): String {\n"
            "            if (!session.active || pending.isEmpty()) return \"\"\n"
            "            pending.setLength(0)\n"
            "            return \"\"\n"
            "        }"
        ),
        "extra": [],
    },
    # M3：漏还原一条映射
    "M3": {
        "why": "restore 漏掉最后一个映射 → 该串在客户端侧永远是占位符",
        "find": (
            "            var result = text\n"
            "            for ((placeholder, original) in restoreMap) result = result.replace(placeholder, original)\n"
            "            return result"
        ),
        "replace": (
            "            var result = text\n"
            "            val all = restoreMap.entries.toList()\n"
            "            for (i in 0 until all.size - 1) {\n"
            "                result = result.replace(all[i].key, all[i].value)\n"
            "            }\n"
            "            return result"
        ),
        "extra": [],
    },
}


# ---------------------------------------------------------------- 工具

def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def ensure_backup():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    if not os.path.isfile(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print("  备份 ->", BACKUP)
    return sha(BACKUP)


def restore():
    shutil.copy2(BACKUP, TARGET)


def gradlew_cmd():
    """Windows 上 gradlew 是无扩展名的 sh 脚本，直接用会 WinError 193；走 .bat。"""
    bat = os.path.join(ROOT, "gradlew.bat")
    if os.name == "nt" and os.path.isfile(bat):
        return [bat]
    return [os.path.join(ROOT, "gradlew")]


def run_tests():
    """返回 (退出码, 失败用例数, 摘要)。"""
    java_home = os.path.expanduser("~/.workbuddy/binaries/jdk-21/jdk-21.0.3+9")
    env = dict(os.environ)
    env["JAVA_HOME"] = java_home
    cmd = gradlew_cmd() + [":core:test", "--no-daemon"]
    for f in TEST_FILTERS:
        cmd += ["--tests", f]
    proc = subprocess.run(
        cmd, cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    fails = count_failures()
    return proc.returncode, fails, out


def count_failures():
    """从 JUnit XML 统计失败+错误总数——比 grep 控制台文本可靠。"""
    total = 0
    res_dir = os.path.join(ROOT, "core", "build", "test-results", "test")
    if not os.path.isdir(res_dir):
        return -1
    for name in os.listdir(res_dir):
        if not name.startswith("TEST-") or not name.endswith(".xml"):
            continue
        if "StreamFidelity" not in name and "PrivacyRedactor" not in name:
            continue
        with open(os.path.join(res_dir, name), "r", encoding="utf-8", errors="replace") as f:
            xml = f.read()
        m_fail = len(re.findall(r"<failure", xml))
        m_err = len(re.findall(r"<error", xml))
        total += m_fail + m_err
    return total


def clean_results():
    res_dir = os.path.join(ROOT, "core", "build", "test-results", "test")
    if not os.path.isdir(res_dir):
        return
    for name in os.listdir(res_dir):
        if name.startswith("TEST-") and ("StreamFidelity" in name or "PrivacyRedactor" in name):
            os.remove(os.path.join(res_dir, name))


def apply_mutation(key):
    spec = MUTATIONS[key]
    with open(TARGET, "r", encoding="utf-8") as f:
        src = f.read()
    if spec["find"] not in src:
        return False, "锚点未命中（源码已变，先核对文件内容）"
    src = src.replace(spec["find"], spec["replace"], 1)
    for find, repl in spec["extra"]:
        if find not in src:
            return False, "附加锚点未命中"
        src = src.replace(find, repl, 1)
    with open(TARGET, "w", encoding="utf-8", newline="\n") as f:
        f.write(src)
    return True, ""


# ---------------------------------------------------------------- 主流程

def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    keys = [only] if only else list(MUTATIONS.keys())

    orig_hash = ensure_backup()
    if sha(TARGET) != orig_hash:
        print("  当前文件已与备份不同，先用备份恢复")
        restore()

    print("== 基线：未变异时必须是绿的 ==")
    clean_results()
    code, fails, out = run_tests()
    if code != 0 or fails < 0:
        print("  基线就不绿，变异测试无意义。退出。")
        print(out[-2000:])
        return 2
    if fails != 0:
        print("  基线有 %d 个失败用例，先修它再谈变异。" % fails)
        return 2
    print("  基线绿（0 failures）")

    verdicts = {}
    for key in keys:
        spec = MUTATIONS[key]
        print("\n== 变异 %s：%s ==" % (key, spec["why"]))
        ok, err = apply_mutation(key)
        if not ok:
            print("  跳过：", err)
            verdicts[key] = "anchor-miss"
            restore()
            continue
        clean_results()
        try:
            code, fails, out = run_tests()
        finally:
            restore()
        if fails < 0:
            print("  无法读取测试结果，判定为环境问题")
            verdicts[key] = "no-result"
            continue
        if fails > 0:
            print("  变红：%d 个失败/错误用例 → 测试网抓住了这个变异" % fails)
            verdicts[key] = "killed"
        elif code != 0:
            print("  构建/编译失败（变异导致代码不可编译，也算被抓，但不可信）→ code=%s" % code)
            verdicts[key] = "compile-only"
        else:
            print("  仍然全绿 → **测试网漏掉了这个变异**")
            verdicts[key] = "survived"

    print("\n== 恢复校验 ==")
    restore()
    final_hash = sha(TARGET)
    print("  恢复后 sha256 =", final_hash)
    print("  与备份一致：", final_hash == orig_hash)

    print("\n== 结论 ==")
    bad = [k for k, v in verdicts.items() if v in ("survived", "anchor-miss", "no-result")]
    for k, v in verdicts.items():
        print("  %s : %s" % (k, v))
    if bad or final_hash != orig_hash:
        print("\n  未通过：%s" % (", ".join(bad) if bad else "文件未正确恢复"))
        return 1
    print("\n  三个变异全部被抓住，源码已恢复原样。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
