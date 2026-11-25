import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # baskstream_client / baskstream_cli
sys.path.insert(0, str(HERE))         # fake_baskstream_station
