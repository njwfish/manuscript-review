import sys
from manuscript_review.library import main as library_main
from manuscript_review.agent import main as agent_main

if __name__ == '__main__':
    if sys.argv[1:2] == ['agent']:
        del sys.argv[1]
        agent_main()
    else:
        library_main()
