"""Add author-controlled thread resolution; retain byte-exact earlier records."""
import copy
from manuscript_review.storage import SCHEMA, validate_record
from . import port_thread_origins, upgrade_records
from .v5 import port_record as port_v5


def port_record(old):
    if old['schema'] == 5:
        return port_v5(old)
    if old['schema'] != 6:
        raise ValueError('Expected a v5 or v6 review record.')
    record = copy.deepcopy(old)
    record.update(schema=SCHEMA, resolved=[])
    return validate_record(port_thread_origins(record))


def upgrade(home):
    return upgrade_records(home, port_record)
