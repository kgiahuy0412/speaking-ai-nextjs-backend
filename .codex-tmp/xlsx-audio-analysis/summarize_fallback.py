import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding="utf-8")

INPUT = Path(r"C:\Users\DELL\Downloads\tong_hop_check_am_thanh_tieu_chuan.xlsx")
SHEET = "Dữ liệu tổng hợp"


def records(frame):
    return frame.replace({np.nan: None}).to_dict(orient="records")


def value_counts(series, include_blank=True):
    normalized = series.astype("object").where(series.notna(), "(trống)") if include_blank else series.dropna()
    return {str(key): int(value) for key, value in normalized.value_counts(dropna=False).items()}


df = pd.read_excel(INPUT, sheet_name=SHEET)
df["Vùng"] = df["Tệp nguồn"].astype(str).str.extract(r"^(MIỀN\s+(?:BẮC|NAM|TRUNG))", expand=False)
df["Mã nhóm"] = df["Đường dẫn audio"].astype(str).str.split("/").str[0]
df["Câu số"] = pd.to_numeric(
    df["Tên file"].astype(str).str.extract(r"(\d+)", expand=False), errors="coerce"
).astype("Int64")
df["Nhóm mã tuổi"] = df["Mã nhóm"].str.extract(r"^[BNT]-(46|710|1114)-", expand=False)
df["Mã G/T"] = df["Mã nhóm"].str.extract(r"^[BNT]-(?:46|710|1114)-([GT])-", expand=False)
df["Là lỗi"] = df["Đánh giá"].eq("Lỗi")
df["Đã đánh giá"] = df["Đánh giá"].isin(["Đúng", "Lỗi"])
df["Mẫu subscribe"] = (
    df["Tiếng Việt nhận diện"]
    .fillna("")
    .str.contains(r"subscribe|La\s*La\s*School|lalaschool", case=False, regex=True)
)

evaluated = df[df["Đã đánh giá"]].copy()

by_region = (
    df.groupby("Vùng", dropna=False)
    .agg(
        tổng=("Tệp nguồn", "size"),
        đúng=("Đánh giá", lambda x: int((x == "Đúng").sum())),
        lỗi=("Đánh giá", lambda x: int((x == "Lỗi").sum())),
        chưa_đánh_giá=("Đánh giá", lambda x: int((x == "Chưa đánh giá").sum())),
        trống_đánh_giá=("Đánh giá", lambda x: int(x.isna().sum())),
        asr_tb_ms=("ASR (ms)", "mean"),
        tổng_tb_ms=("Tổng thời gian (ms)", "mean"),
        mẫu_subscribe=("Mẫu subscribe", "sum"),
    )
    .reset_index()
)
by_region["tỷ_lệ_lỗi_trên_đã_đánh_giá"] = by_region["lỗi"] / (by_region["đúng"] + by_region["lỗi"])

def grouped_quality(column):
    grouped = (
        df.groupby(column, dropna=False)
        .agg(
            tổng=("Tên file", "size"),
            đúng=("Đánh giá", lambda x: int((x == "Đúng").sum())),
            lỗi=("Là lỗi", "sum"),
            chưa_đánh_giá=("Đánh giá", lambda x: int((x == "Chưa đánh giá").sum())),
            lỗi_xử_lý=("Đánh giá", lambda x: int((x == "Lỗi xử lý").sum())),
            mẫu_subscribe=("Mẫu subscribe", "sum"),
            asr_tb_ms=("ASR (ms)", "mean"),
            tổng_tb_ms=("Tổng thời gian (ms)", "mean"),
        )
        .reset_index()
    )
    grouped["tỷ_lệ_lỗi_nội_dung"] = grouped["lỗi"] / (grouped["đúng"] + grouped["lỗi"])
    return grouped

by_age_code = grouped_quality("Nhóm mã tuổi")
by_gt_code = grouped_quality("Mã G/T")

by_prompt = (
    df.groupby("Câu số", dropna=False)
    .agg(
        tổng=("Tệp nguồn", "size"),
        đã_đánh_giá=("Đã đánh giá", "sum"),
        lỗi=("Là lỗi", "sum"),
        mẫu_subscribe=("Mẫu subscribe", "sum"),
        asr_tb_ms=("ASR (ms)", "mean"),
        tổng_tb_ms=("Tổng thời gian (ms)", "mean"),
    )
    .reset_index()
)
by_prompt["tỷ_lệ_lỗi"] = by_prompt["lỗi"] / by_prompt["đã_đánh_giá"]
by_prompt = by_prompt.sort_values(["tỷ_lệ_lỗi", "lỗi"], ascending=[False, False])

by_source = (
    df.groupby("Tệp nguồn", dropna=False)
    .agg(
        tổng=("Tên file", "size"),
        đã_đánh_giá=("Đã đánh giá", "sum"),
        đúng=("Đánh giá", lambda x: int((x == "Đúng").sum())),
        lỗi=("Là lỗi", "sum"),
        chưa_đánh_giá=("Đánh giá", lambda x: int((x == "Chưa đánh giá").sum())),
        lỗi_kỹ_thuật=("Lỗi kỹ thuật", lambda x: int(x.notna().sum())),
        mẫu_subscribe=("Mẫu subscribe", "sum"),
        asr_tb_ms=("ASR (ms)", "mean"),
        tổng_tb_ms=("Tổng thời gian (ms)", "mean"),
    )
    .reset_index()
)
by_source["tỷ_lệ_lỗi"] = by_source["lỗi"] / by_source["đã_đánh_giá"].replace(0, np.nan)
worst_sources = by_source.sort_values(["tỷ_lệ_lỗi", "lỗi"], ascending=[False, False]).head(12)
best_sources = by_source[by_source["đã_đánh_giá"] >= 10].sort_values(
    ["tỷ_lệ_lỗi", "đúng"], ascending=[True, False]
).head(8)

latency = {}
for column in ["ASR (ms)", "Tổng thời gian (ms)"]:
    values = pd.to_numeric(df[column], errors="coerce").dropna()
    latency[column] = {
        "count": int(values.count()),
        "mean": round(float(values.mean()), 1),
        "median": round(float(values.median()), 1),
        "p90": round(float(values.quantile(0.90)), 1),
        "p95": round(float(values.quantile(0.95)), 1),
        "max": round(float(values.max()), 1),
        "over_2000": int((values > 2000).sum()),
        "over_3000": int((values > 3000).sum()),
    }

latency_by_evaluation = (
    df.groupby(df["Đánh giá"].fillna("(trống)"))
    .agg(
        số_mẫu=("Tên file", "size"),
        asr_tb_ms=("ASR (ms)", "mean"),
        asr_trung_vị_ms=("ASR (ms)", "median"),
        tổng_tb_ms=("Tổng thời gian (ms)", "mean"),
        tổng_trung_vị_ms=("Tổng thời gian (ms)", "median"),
    )
    .reset_index(names="đánh_giá")
)

technical_rows = df[df["Lỗi kỹ thuật"].notna()][
    [
        "Tệp nguồn",
        "Đường dẫn audio",
        "Đánh giá",
        "Loại lỗi",
        "Trạng thái xử lý",
        "Lỗi kỹ thuật",
        "ASR (ms)",
        "Tổng thời gian (ms)",
    ]
]

subscribe_rows = df[df["Mẫu subscribe"]][
    ["Tệp nguồn", "Đường dẫn audio", "Câu số", "Đánh giá", "Tiếng Việt nhận diện", "Tiếng Anh"]
]

summary = {
    "shape": {"rows": int(df.shape[0]), "columns": int(df.shape[1])},
    "columns": list(df.columns[:16]),
    "evaluation_counts": value_counts(df["Đánh giá"]),
    "evaluated_total": int(df["Đã đánh giá"].sum()),
    "correct_total": int((df["Đánh giá"] == "Đúng").sum()),
    "error_total": int(df["Là lỗi"].sum()),
    "error_rate_evaluated": round(float(df.loc[df["Đã đánh giá"], "Là lỗi"].mean()), 6),
    "error_rate_all": round(float(df["Là lỗi"].mean()), 6),
    "error_type_counts": value_counts(df["Loại lỗi"]),
    "processing_status_counts": value_counts(df["Trạng thái xử lý"]),
    "technical_error_counts": value_counts(df["Lỗi kỹ thuật"]),
    "mode_counts": value_counts(df["Chế độ"]),
    "context_counts": value_counts(df["Ngữ cảnh"]),
    "region_summary": records(by_region.round(4)),
    "age_code_summary": records(by_age_code.round(4)),
    "gt_code_summary": records(by_gt_code.round(4)),
    "prompt_summary_ranked": records(by_prompt.round(4)),
    "worst_sources": records(worst_sources.round(4)),
    "best_sources": records(best_sources.round(4)),
    "latency": latency,
    "latency_by_evaluation": records(latency_by_evaluation.round(1)),
    "subscribe_pattern": {
        "count": int(df["Mẫu subscribe"].sum()),
        "evaluation_counts": value_counts(subscribe_rows["Đánh giá"]),
        "by_prompt": value_counts(subscribe_rows["Câu số"]),
        "examples": records(subscribe_rows.head(8)),
    },
    "data_quality": {
        "duplicate_audio_paths": int(df["Đường dẫn audio"].duplicated().sum()),
        "duplicate_conversation_ids": int(df["Conversation ID"].dropna().duplicated().sum()),
        "rows_total_less_than_asr": int(
            (pd.to_numeric(df["Tổng thời gian (ms)"], errors="coerce") < pd.to_numeric(df["ASR (ms)"], errors="coerce")).sum()
        ),
        "missing_by_column": {column: int(df[column].isna().sum()) for column in df.columns[:16]},
    },
    "technical_rows": records(technical_rows),
}

print(json.dumps(summary, ensure_ascii=False, indent=2))
